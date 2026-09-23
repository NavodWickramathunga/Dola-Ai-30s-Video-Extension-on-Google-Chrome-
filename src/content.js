// Content script on dola.com.
// - Tells page-hook.js which prompt you just sent, so it can turn that request into a
//   single 30-second Seedance generation.
// - After you send a prompt, watches for the finished video and downloads it automatically.
/* global DOLA_DEFAULTS */
(() => {
  if (window.__dolaVideoContentLoaded) return;
  window.__dolaVideoContentLoaded = true;

  const LOG = (...a) => console.log('[Dola 30s Video]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let settings = { ...DOLA_DEFAULTS };

  // ---------- Settings → page hook ----------
  function pushConfig() {
    window.postMessage({
      source: 'dola-video-content',
      type: 'config',
      config: {
        forceDuration: settings.forceDuration,
        seconds: Number(settings.seconds) || 30,
        appendInstruction: settings.appendInstruction,
        instructionText: String(settings.instruction || '').replace(/\{seconds\}/g, Number(settings.seconds) || 30)
      }
    }, '*');
  }
  async function loadSettings() {
    const { settings: saved } = await chrome.storage.local.get('settings');
    settings = { ...DOLA_DEFAULTS, ...(saved || {}) };
    pushConfig();
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) loadSettings();
  });

  // ---------- Messages from page-hook.js ----------
  const hookedUrls = new Map(); // url -> time seen
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'dola-video-hook') return;
    const d = e.data;
    if (d.type === 'hook-ready') pushConfig();
    else if (d.type === 'video-url' && !hookedUrls.has(d.url)) hookedUrls.set(d.url, Date.now());
    else if (d.type === 'rewrote') {
      LOG('made this prompt a single', settings.seconds, 's video:', d.changes);
      chrome.storage.local.set({ lastRewrite: { at: Date.now(), changes: d.changes } });
    }
  });

  // ---------- Detect when you send a prompt ----------
  let lastComposerText = '';
  let armedUntil = 0; // auto-download only runs for a while after you send a prompt

  const isEditable = (el) =>
    el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text') || el.isContentEditable);
  const readText = (el) => (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? el.value : el.innerText) || '';

  function onPromptSent(text) {
    if (!text || !text.trim()) return;
    document.dispatchEvent(new CustomEvent('dola-video-pending', { detail: text }));
    armedUntil = Date.now() + settings.waitMinutes * 60 * 1000;
    chrome.storage.local.set({ lastSent: { at: Date.now(), text: text.slice(0, 200) } });
  }

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (isEditable(el)) lastComposerText = readText(el);
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    const el = e.target;
    if (isEditable(el)) onPromptSent(readText(el) || lastComposerText);
  }, true);

  // Clicking the send button (any button while the composer has text)
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest && e.target.closest('button, [role="button"]');
    if (!btn || !lastComposerText.trim()) return;
    const active = document.activeElement;
    const text = isEditable(active) ? readText(active) : lastComposerText;
    if (text.trim()) onPromptSent(text);
  }, true);

  // ---------- Finding the generated video ----------
  const DOWNLOADABLE_RE = /\.(mp4|webm|mov)(\?|#|$)/i;
  const keyOf = (url) => {
    try {
      const u = new URL(url, location.href);
      return u.protocol === 'blob:' ? url : u.origin + u.pathname;
    } catch (_) {
      return url;
    }
  };

  function collectCandidates() {
    const found = new Map(); // key -> { url, el, source }
    document.querySelectorAll('video').forEach((v) => {
      for (const url of [v.currentSrc, v.src, ...[...v.querySelectorAll('source')].map((s) => s.src)]) {
        if (url && !found.has(keyOf(url))) found.set(keyOf(url), { url, el: v, source: 'video' });
      }
    });
    document.querySelectorAll('a[href]').forEach((a) => {
      if (DOWNLOADABLE_RE.test(a.href) && !found.has(keyOf(a.href))) found.set(keyOf(a.href), { url: a.href, el: a, source: 'link' });
    });
    for (const [url] of hookedUrls) {
      if (DOWNLOADABLE_RE.test(url) && !found.has(keyOf(url))) found.set(keyOf(url), { url, el: null, source: 'network' });
    }
    return found;
  }

  function videoDuration(c) {
    return c.el && c.el.tagName === 'VIDEO' && Number.isFinite(c.el.duration) ? c.el.duration : null;
  }

  function looksFinished(c) {
    if (!c.el || c.el.tagName !== 'VIDEO') return true;
    const d = c.el.duration;
    if (Number.isFinite(d) && d > 0) return d >= settings.minVideoSeconds;
    if (d === Infinity && c.el.readyState >= 1) return true; // streamed file without a duration header
    if (c.el.error) return true;
    return c.el.readyState === 0 && c.el.preload === 'none';
  }

  // ---------- Downloading ----------
  async function downloadVideo(c) {
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const folder = (settings.downloadFolder || 'DolaAI').replace(/[\\:*?"<>|]+/g, ' ').trim();
    const prefix = (settings.filePrefix || 'dola').replace(/[\\/:*?"<>|]+/g, ' ').trim();
    const filename = `${folder}/${prefix}_${settings.seconds}s_${stamp}.mp4`;
    const duration = videoDuration(c);
    let result;
    if (c.url.startsWith('blob:')) {
      // Blob URLs belong to the page, so save them from here.
      const blob = await (await fetch(c.url)).blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename.split('/').pop();
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      result = { ok: true };
    } else {
      result = await chrome.runtime.sendMessage({ type: 'download', url: c.url, filename, duration });
    }
    const { history = [] } = await chrome.storage.local.get('history');
    history.unshift({ at: Date.now(), url: c.url, filename, duration, ok: !!(result && result.ok), error: result && result.error });
    await chrome.storage.local.set({ history: history.slice(0, 20) });
    LOG('downloaded', filename, duration ? `${duration.toFixed(1)}s` : '');
    return result;
  }

  // ---------- Watcher ----------
  const handled = new Set();
  const pendingSince = new Map(); // key -> first time it looked finished

  async function tick() {
    if (!settings.autoDownload || Date.now() > armedUntil) return;
    const now = Date.now();
    const candidates = collectCandidates();
    const domKeys = new Set([...candidates].filter(([, c]) => c.source !== 'network').map(([k]) => k));
    for (const [k, c] of candidates) {
      if (handled.has(k) || !looksFinished(c)) continue;
      if (!pendingSince.has(k)) { pendingSince.set(k, now); continue; }
      const age = now - pendingSince.get(k);
      // Give the page a few seconds to swap preview URLs for the final file. Network-only
      // URLs wait longer so the on-page <video> (the one you actually see) wins when both exist.
      if (age < (c.source === 'network' ? 30000 : 5000)) continue;
      if (c.source === 'network' && domKeys.size && [...domKeys].some((dk) => !handled.has(dk))) continue;
      handled.add(k);
      pendingSince.delete(k);
      try { await downloadVideo(c); } catch (e) { LOG('download failed', e); }
    }
  }

  async function start() {
    await loadSettings();
    // Anything already on the page (old chats, examples) is not new: never auto-download it.
    await sleep(4000);
    for (const k of collectCandidates().keys()) handled.add(k);
    // Chat history loaded later is also old: keep marking videos as handled until you send something.
    setInterval(() => {
      if (Date.now() > armedUntil) for (const k of collectCandidates().keys()) handled.add(k);
    }, 3000);
    setInterval(() => tick().catch((e) => LOG('watch error', e)), 2500);
  }
  start();

  // ---------- Popup commands ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'ping') {
      sendResponse({ ok: true, armed: Date.now() < armedUntil });
    } else if (msg.type === 'downloadLatest') {
      // Manual fallback: save the newest finished video on the page.
      const list = [...collectCandidates().values()].filter((c) => c.source !== 'network' && looksFinished(c));
      const latest = list.pop() || [...collectCandidates().values()].pop();
      if (!latest) { sendResponse({ ok: false, error: 'No video found on this page.' }); return false; }
      handled.add(keyOf(latest.url));
      downloadVideo(latest).then((r) => sendResponse(r || { ok: true })).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    return false;
  });

  LOG('ready');
})();
