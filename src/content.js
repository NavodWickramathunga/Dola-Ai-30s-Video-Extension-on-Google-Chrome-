// Content script on dola.com: types the prompts into the Dola chat, waits for the
// Seedance video to finish, and hands the video URL to the background worker to download.
/* global DOLA_DEFAULTS */
(() => {
  if (window.__dolaVideoContentLoaded) return;
  window.__dolaVideoContentLoaded = true;

  const LOG = (...a) => console.log('[Dola 30s Video]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let stopRequested = false;
  let jobRunning = false;

  // ---------- Video URLs seen on the network (from page-hook.js) ----------
  const hookedUrls = new Map(); // url -> timestamp
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'dola-video-hook') return;
    if (e.data.type === 'video-url' && !hookedUrls.has(e.data.url)) {
      hookedUrls.set(e.data.url, Date.now());
    }
  });

  async function getSettings() {
    const { settings } = await chrome.storage.local.get('settings');
    return { ...DOLA_DEFAULTS, ...(settings || {}) };
  }

  // ---------- DOM helpers ----------
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  }

  function findInput(s) {
    if (s.inputSelector) {
      const el = document.querySelector(s.inputSelector);
      if (el) return el;
    }
    const candidates = [
      ...document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]')
    ].filter((el) => isVisible(el) && !el.closest('[aria-hidden="true"]') && !el.readOnly && !el.disabled);
    if (!candidates.length) return null;
    // Prefer the chat composer: the lowest, widest editable on screen.
    candidates.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.bottom + rb.width * 0.1 - (ra.bottom + ra.width * 0.1);
    });
    return candidates[0];
  }

  function readInput(el) {
    return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? el.value : el.innerText;
  }

  async function setInputText(el, text) {
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, text); // bypass React's value tracking
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      // contenteditable (Lexical / Slate / ProseMirror style editors)
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('delete');
      let ok = document.execCommand('insertText', false, text);
      await sleep(50);
      if (!ok || readInput(el).trim().length < Math.min(10, text.trim().length)) {
        // Fallback: synthetic paste
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      }
    }
    await sleep(300);
    return readInput(el).trim().length > 0;
  }

  function findSendButton(input, s) {
    if (s.sendSelector) {
      const el = document.querySelector(s.sendSelector);
      if (el) return el;
    }
    const SEND_RE = /send|submit|发送|enviar|envoyer|senden|invia|отправ/i;
    const all = [...document.querySelectorAll('button, [role="button"]')].filter(isVisible);
    const labelled = all.filter((b) =>
      SEND_RE.test(
        [b.getAttribute('aria-label'), b.getAttribute('data-testid'), b.getAttribute('title'), b.id, b.className]
          .filter((v) => typeof v === 'string')
          .join(' ')
      )
    );
    if (labelled.length) return labelled[labelled.length - 1];
    // Otherwise: the right-most button inside the composer container.
    let node = input;
    for (let depth = 0; depth < 7 && node; depth++, node = node.parentElement) {
      const btns = [...node.querySelectorAll('button, [role="button"]')].filter(isVisible);
      if (btns.length) {
        btns.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
        return btns[0];
      }
    }
    return null;
  }

  function pressEnter(el) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  async function submitPrompt(text, s) {
    const input = findInput(s);
    if (!input) throw new Error('Could not find the Dola chat box. Open a Dola chat, or set "Prompt box selector" in Settings.');
    if (!(await setInputText(input, text))) throw new Error('Could not type into the Dola chat box.');

    // Wait for the send button to become enabled.
    let btn = null;
    for (let i = 0; i < 20; i++) {
      btn = findSendButton(input, s);
      if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') break;
      await sleep(250);
    }
    if (btn && !btn.disabled) btn.click();
    else pressEnter(input);

    // Confirm the message was sent (composer clears). Retry with Enter once.
    for (let i = 0; i < 12; i++) {
      await sleep(250);
      if (readInput(input).trim().length === 0) return;
    }
    pressEnter(input);
    await sleep(1500);
    if (readInput(input).trim().length > 0) {
      throw new Error('The prompt was typed but not sent. Set "Send button selector" in Settings.');
    }
  }

  // ---------- Finding generated videos ----------
  const keyOf = (url) => {
    try {
      const u = new URL(url, location.href);
      return u.protocol === 'blob:' ? url : u.origin + u.pathname;
    } catch (_) {
      return url;
    }
  };
  const DOWNLOADABLE_RE = /\.(mp4|webm|mov)(\?|#|$)/i;

  function collectCandidates() {
    const found = new Map(); // key -> { url, el, source }
    document.querySelectorAll('video').forEach((v) => {
      const urls = [v.currentSrc, v.src, ...[...v.querySelectorAll('source')].map((s) => s.src)];
      for (const url of urls) {
        if (url && !found.has(keyOf(url))) found.set(keyOf(url), { url, el: v, source: 'video' });
      }
    });
    document.querySelectorAll('a[href]').forEach((a) => {
      if (DOWNLOADABLE_RE.test(a.href) && !found.has(keyOf(a.href))) {
        found.set(keyOf(a.href), { url: a.href, el: a, source: 'link' });
      }
    });
    for (const url of hookedUrls.keys()) {
      if (DOWNLOADABLE_RE.test(url) && !found.has(keyOf(url))) found.set(keyOf(url), { url, el: null, source: 'network' });
    }
    return found;
  }

  function videoLooksFinished(c, s) {
    if (!c.el || c.el.tagName !== 'VIDEO') return true;
    const d = c.el.duration;
    if (Number.isFinite(d) && d > 0) return d >= s.minVideoSeconds;
    if (d === Infinity && c.el.readyState >= 1) return true; // streamed file without a duration header
    if (c.el.error) return true; // page can't play it, but the URL may still download fine
    if (c.el.readyState === 0 && c.el.preload === 'none') return true; // can't know; trust it
    return false;
  }

  async function waitForNewVideo(beforeKeys, s, onTick) {
    const deadline = Date.now() + s.clipTimeoutMin * 60 * 1000;
    let firstSeenAt = 0;
    while (Date.now() < deadline) {
      if (stopRequested) throw new Error('Stopped');
      const fresh = [...collectCandidates().entries()].filter(([k]) => !beforeKeys.has(k)).map(([, c]) => c);
      const ready = fresh.filter((c) => videoLooksFinished(c, s));
      if (ready.length) {
        if (!firstSeenAt) firstSeenAt = Date.now();
        // Give the page a few seconds to swap preview URLs for the final one.
        if (Date.now() - firstSeenAt > 5000) {
          const rank = (c) => (c.source === 'video' ? 0 : c.source === 'link' ? 1 : 2);
          ready.sort((a, b) => rank(a) - rank(b));
          const withDuration = ready.filter((c) => c.el && Number.isFinite(c.el.duration));
          return (withDuration.sort((a, b) => b.el.duration - a.el.duration)[0] || ready[0]).url;
        }
      }
      onTick && onTick(Math.round((deadline - Date.now()) / 1000));
      await sleep(2500);
    }
    throw new Error(`No video appeared within ${s.clipTimeoutMin} minutes.`);
  }

  // ---------- Downloading ----------
  async function downloadVideo(url, filename) {
    if (url.startsWith('blob:')) {
      // Blob URLs belong to the page, so save them from here.
      const blob = await (await fetch(url)).blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename.split('/').pop();
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      return { ok: true, via: 'page' };
    }
    return chrome.runtime.sendMessage({ type: 'download', url, filename });
  }

  // ---------- Job runner ----------
  async function updateJob(patch) {
    const { job } = await chrome.storage.local.get('job');
    const next = { ...(job || {}), ...patch, updatedAt: Date.now() };
    await chrome.storage.local.set({ job: next });
    return next;
  }
  async function updateClip(i, patch) {
    const { job } = await chrome.storage.local.get('job');
    if (!job) return;
    job.clips[i] = { ...job.clips[i], ...patch };
    job.updatedAt = Date.now();
    await chrome.storage.local.set({ job });
  }

  async function runJob(job) {
    if (jobRunning) return;
    jobRunning = true;
    stopRequested = false;
    const s = { ...(await getSettings()), ...(job.settings || {}) };
    try {
      for (let i = 0; i < job.clips.length; i++) {
        if (job.clips[i].status === 'done') continue;
        if (stopRequested) throw new Error('Stopped');
        const clip = job.clips[i];
        await updateClip(i, { status: 'sending', error: '' });
        await updateJob({ status: 'running', message: `Sending part ${clip.part}/${clip.total}…` });

        const before = new Set(collectCandidates().keys());
        await submitPrompt(clip.prompt, s);
        await updateClip(i, { status: 'generating', startedAt: Date.now() });

        const url = await waitForNewVideo(before, s, (left) =>
          updateJob({ message: `Generating part ${clip.part}/${clip.total}… (timeout in ${Math.floor(left / 60)}m ${left % 60}s)` })
        );
        LOG('video ready', url);
        await markDownloaded(url);

        const filename = `${job.folder}/${job.baseName}_part${clip.part}of${clip.total}.mp4`;
        let dl = { ok: false };
        if (s.autoDownload) {
          dl = await downloadVideo(url, filename).catch((e) => ({ ok: false, error: e.message }));
        }
        await updateClip(i, {
          status: 'done',
          url,
          filename,
          downloaded: !!(dl && dl.ok),
          error: dl && dl.error ? `Download failed: ${dl.error}` : ''
        });
        // Short pause so Dola settles before the next prompt.
        if (i < job.clips.length - 1) await sleep(3000);
      }
      await updateJob({ status: 'generated', message: 'All parts generated.' });
      chrome.runtime.sendMessage({ type: 'jobGenerated' });
    } catch (e) {
      LOG('job error', e);
      await updateJob({ status: stopRequested ? 'stopped' : 'error', message: e.message });
      chrome.runtime.sendMessage({ type: 'jobFailed', error: e.message });
    } finally {
      jobRunning = false;
    }
  }

  // ---------- Watch mode: auto-download any new video ----------
  async function markDownloaded(url) {
    const { downloadedKeys = [] } = await chrome.storage.local.get('downloadedKeys');
    const k = keyOf(url);
    if (!downloadedKeys.includes(k)) {
      downloadedKeys.push(k);
      await chrome.storage.local.set({ downloadedKeys: downloadedKeys.slice(-500) });
    }
  }

  async function startWatcher() {
    await sleep(6000); // ignore videos that were already on the page when it loaded
    const baseline = new Set(collectCandidates().keys());
    const pending = new Map(); // key -> first seen
    setInterval(async () => {
      if (jobRunning) return; // the job downloads its own clips
      const s = await getSettings();
      if (!s.watchMode) return;
      const { downloadedKeys = [] } = await chrome.storage.local.get('downloadedKeys');
      for (const [k, c] of collectCandidates()) {
        if (baseline.has(k) || downloadedKeys.includes(k)) continue;
        if (!videoLooksFinished(c, s)) continue;
        if (!pending.has(k)) { pending.set(k, Date.now()); continue; }
        if (Date.now() - pending.get(k) < 5000) continue;
        pending.delete(k);
        await markDownloaded(c.url);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        downloadVideo(c.url, `${s.downloadFolder}/${s.filePrefix}_${stamp}.mp4`).catch((e) => LOG('watch download failed', e));
      }
    }, 4000);
  }
  startWatcher();

  // ---------- Messages ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'ping') {
      sendResponse({ ok: true, hasInput: !!findInput({ ...DOLA_DEFAULTS }), jobRunning });
    } else if (msg.type === 'runJob') {
      runJob(msg.job);
      sendResponse({ ok: true });
    } else if (msg.type === 'stopJob') {
      stopRequested = true;
      sendResponse({ ok: true });
    } else if (msg.type === 'fetchBlobAsDataUrl') {
      // Used by the merger for blob: videos that only this page can read.
      fetch(msg.url)
        .then((r) => r.blob())
        .then((b) => new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); }))
        .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    return false;
  });

  chrome.runtime.sendMessage({ type: 'contentLoaded' }).catch(() => {});
  LOG('ready');
})();
