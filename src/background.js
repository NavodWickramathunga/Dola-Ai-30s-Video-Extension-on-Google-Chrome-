// Service worker: starts jobs, opens the Dola tab, performs downloads and launches the merger.
/* global DOLA_DEFAULTS, buildClipPrompts */
importScripts('shared.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DOLA_DEFAULTS, ...(settings || {}) };
}

async function setJob(patch) {
  const { job } = await chrome.storage.local.get('job');
  const next = { ...(job || {}), ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ job: next });
  return next;
}

function sanitize(name) {
  return (name || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function slugFromPrompt(prompt) {
  return sanitize(prompt).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'video';
}

function waitForTabComplete(tabId, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(listener); clearTimeout(t); resolve(); };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const t = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => { if (tab.status === 'complete') done(); }).catch(done);
  });
}

async function pingContent(tabId, tries = 20) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
      if (res && res.ok) return res;
    } catch (_) { /* content script not ready yet */ }
    await sleep(1000);
  }
  return null;
}

async function getDolaTab(settings) {
  const tabs = await chrome.tabs.query({ url: 'https://*.dola.com/*' });
  const chatTab = tabs.find((t) => t.active) || tabs.find((t) => /\/chat/.test(t.url)) || tabs[0];
  if (chatTab && !settings.newChatPerJob) {
    await chrome.tabs.update(chatTab.id, { active: true });
    await chrome.windows.update(chatTab.windowId, { focused: true });
    return chatTab;
  }
  const tab = await chrome.tabs.create({ url: settings.dolaUrl, active: true });
  await waitForTabComplete(tab.id);
  return tab;
}

async function startJob(prompt) {
  const settings = await getSettings();
  const clips = buildClipPrompts(prompt, settings).map((c) => ({ ...c, status: 'queued' }));
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  let job = {
    id: Date.now(),
    prompt,
    status: 'starting',
    message: 'Opening Dola…',
    clips,
    folder: sanitize(settings.downloadFolder) || 'DolaAI',
    baseName: `${sanitize(settings.filePrefix) || 'dola'}_${stamp}_${slugFromPrompt(prompt)}`,
    settings,
    merged: null,
    createdAt: Date.now()
  };
  await chrome.storage.local.set({ job });

  const tab = await getDolaTab(settings);
  job = await setJob({ tabId: tab.id });
  let ready = await pingContent(tab.id, 5);
  if (!ready) {
    // Tab was open before the extension was installed/updated: reload so the script injects.
    await chrome.tabs.reload(tab.id);
    await waitForTabComplete(tab.id);
    ready = await pingContent(tab.id, 20);
  }
  if (!ready) {
    await setJob({ status: 'error', message: 'Could not connect to the Dola page. Reload dola.com and try again.' });
    return;
  }
  await sleep(1500);
  await chrome.tabs.sendMessage(tab.id, { type: 'runJob', job });
}

async function stopJob() {
  const { job } = await chrome.storage.local.get('job');
  if (job && job.tabId) {
    try { await chrome.tabs.sendMessage(job.tabId, { type: 'stopJob' }); } catch (_) { /* tab gone */ }
  }
  await setJob({ status: 'stopped', message: 'Stopped by you.' });
}

async function download(url, filename) {
  try {
    const id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function notify(title, message) {
  chrome.notifications.create({ type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title, message }, () => void chrome.runtime.lastError);
}

async function onJobGenerated() {
  const { job } = await chrome.storage.local.get('job');
  if (!job) return;
  const settings = { ...(await getSettings()), ...(job.settings || {}) };
  if (settings.mergeClips && job.clips.length > 1) {
    await setJob({ status: 'merging', message: 'Stitching the parts into one video…' });
    await chrome.tabs.create({ url: chrome.runtime.getURL('src/merge.html'), active: true });
  } else {
    await setJob({ status: 'done', message: 'Done! Check your Downloads folder.' });
    notify('Dola video ready', `${job.clips.length} video file(s) saved to Downloads/${job.folder}`);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'startJob':
        startJob(msg.prompt).catch((e) => setJob({ status: 'error', message: e.message }));
        return { ok: true };
      case 'stopJob':
        await stopJob();
        return { ok: true };
      case 'download':
        return download(msg.url, msg.filename);
      case 'jobGenerated':
        await onJobGenerated();
        return { ok: true };
      case 'jobFailed':
        notify('Dola video failed', msg.error || 'Unknown error');
        return { ok: true };
      case 'mergeDone':
        await setJob({ status: 'done', merged: msg.filename, message: 'Done! Full video saved.' });
        notify('Your 30s video is ready', `Saved to Downloads/${msg.filename}`);
        return { ok: true };
      case 'contentLoaded': {
        // A fresh content script in the job's tab means the page fully reloaded mid-job.
        const { job } = await chrome.storage.local.get('job');
        if (job && sender.tab && job.tabId === sender.tab.id && job.status === 'running') {
          await setJob({ status: 'error', message: 'The Dola page reloaded during generation. Press Start to try again.' });
        }
        return { ok: true };
      }
      case 'mergeFailed':
        await setJob({ status: 'done', message: `Parts downloaded, but stitching failed: ${msg.error}` });
        return { ok: true };
      default:
        return { ok: false, error: 'unknown message' };
    }
  })().then(sendResponse);
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { job } = await chrome.storage.local.get('job');
  if (job && job.tabId === tabId && ['starting', 'running'].includes(job.status)) {
    await setJob({ status: 'error', message: 'The Dola tab was closed during generation.' });
  }
});

