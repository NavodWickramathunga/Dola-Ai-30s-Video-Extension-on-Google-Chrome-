/* global DOLA_DEFAULTS, withDefaults */
const $ = (sel) => document.querySelector(sel);
const settingEls = [...document.querySelectorAll('[data-setting]')];
let settings = { ...DOLA_DEFAULTS };

const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(t).toLocaleString();
};

async function loadSettings() {
  const { settings: saved } = await chrome.storage.local.get('settings');
  settings = withDefaults(saved);
  for (const el of settingEls) {
    const v = settings[el.dataset.setting];
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  }
}

async function saveSettings() {
  for (const el of settingEls) {
    settings[el.dataset.setting] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
  }
  await chrome.storage.local.set({ settings });
  render();
}

async function dolaTab() {
  const tabs = await chrome.tabs.query({ url: 'https://*.dola.com/*' });
  return tabs.find((t) => t.active) || tabs[0] || null;
}

async function render() {
  const { history = [], lastSent, lastRewrite, clipSession } = await chrome.storage.local.get(['history', 'lastSent', 'lastRewrite', 'clipSession']);

  const tab = await dolaTab();
  let status = 'Dola is not open';
  if (tab) {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'ping' });
      status = res && res.armed ? 'Watching for your video…' : 'Ready on Dola';
    } catch (_) {
      status = 'Reload the Dola tab to activate';
    }
  }
  $('#tabStatus').textContent = status;

  $('#lastSent').textContent = lastSent ? `Last prompt sent ${ago(lastSent.at)}: "${lastSent.text.slice(0, 70)}${lastSent.text.length > 70 ? '…' : ''}"` : 'Send a prompt on Dola to start.';

  const rw = $('#lastRewrite');
  if (lastRewrite && lastSent && Math.abs(lastRewrite.at - lastSent.at) < 30000) {
    rw.className = 'small-line st-done';
    rw.textContent = `✓ ${lastRewrite.changes.join('; ')}`;
  } else rw.textContent = '';

  const cs = $('#clipStatus');
  const clips = (clipSession && clipSession.clips) || [];
  if (settings.joinClips && clips.length) {
    const total = clips.reduce((sum, c) => sum + (c.duration || 0), 0);
    cs.className = 'small-line ' + (clipSession.done ? 'st-done' : '');
    cs.textContent = clipSession.done
      ? `✓ ${clips.length} clip(s), ${Math.round(total)}s in total: sent for joining.`
      : `Clips received: ${clips.length} (${Math.round(total)}s of ${settings.seconds}s). Waiting for the rest…`;
    $('#joinNow').hidden = clipSession.done || clips.length < 1;
  } else {
    cs.textContent = '';
    $('#joinNow').hidden = true;
  }


  const box = $('#historyBox');
  box.hidden = !history.length;
  $('#history').replaceChildren(
    ...history.slice(0, 8).map((h) => {
      const li = document.createElement('li');
      const len = h.duration ? `${h.duration.toFixed(1)}s` : 'length unknown';
      const short = h.duration && h.duration < settings.seconds - 1;
      li.className = h.ok === false ? 'st-error' : short ? 'st-warn' : 'st-done';
      li.textContent = `${h.filename.split('/').pop()} · ${len}${h.joined ? ` · ${h.joined} clips joined` : ''} · ${ago(h.at)}`;
      if (h.ok === false) li.textContent += ` · failed: ${h.error || 'unknown error'}`;
      else if (short) li.textContent += ` · shorter than ${settings.seconds}s: Dola/Seedance capped the length`;
      return li;
    })
  );
}

settingEls.forEach((el) => el.addEventListener('change', saveSettings));

$('#openDola').addEventListener('click', async () => {
  const tab = await dolaTab();
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: 'https://www.dola.com/chat/' });
  }
  window.close();
});

$('#downloadNow').addEventListener('click', async () => {
  const btn = $('#downloadNow');
  const tab = await dolaTab();
  if (!tab) { btn.textContent = 'Open Dola first'; return; }
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'downloadLatest' });
    btn.textContent = res && res.ok ? 'Downloading ✓' : (res && res.error) || 'Nothing found';
  } catch (_) {
    btn.textContent = 'Reload the Dola tab first';
  }
  setTimeout(() => { btn.textContent = 'Download latest video now'; }, 3000);
  render();
});

$('#joinNow').addEventListener('click', async () => {
  const tab = await dolaTab();
  if (!tab) return;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'joinNow' });
    if (!res || !res.ok) $('#joinNow').textContent = (res && res.error) || 'Could not join';
  } catch (_) {
    $('#joinNow').textContent = 'Reload the Dola tab first';
  }
});

$('#reset').addEventListener('click', async () => {
  await chrome.storage.local.set({ settings: { ...DOLA_DEFAULTS } });
  await loadSettings();
  render();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.history || changes.lastSent || changes.lastRewrite || changes.clipSession)) render();
});

(async () => {
  await loadSettings();
  await render();
})();
