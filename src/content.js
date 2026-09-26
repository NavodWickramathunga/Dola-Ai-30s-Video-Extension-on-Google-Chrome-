// Content script on dola.com.
// - Tells page-hook.js which prompt you just sent, so it can turn that request into a
//   single 30-second Seedance generation.
// - After you send a prompt, watches for the finished video and downloads it automatically.
/* global DOLA_DEFAULTS, withDefaults */
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
    settings = withDefaults(saved);
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
    else if (d.type === 'net-log') {
      chrome.storage.local.get('netLog').then(({ netLog = [] }) => {
        netLog.push(d.entry);
        chrome.storage.local.set({ netLog: netLog.slice(-25) });
      });
    } else if (d.type === 'rewrote') {
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
    // A new request starts a new set of clips, unless the last set is still being collected
    // (e.g. you replied "confirm" to Dola's plan while its clips are on the way).
    if (!session || session.done || Date.now() - session.lastActivity > settings.waitMinutes * 60 * 1000) {
      session = { id: Date.now(), clips: [], lastActivity: Date.now(), done: false };
    } else {
      session.lastActivity = Date.now();
    }
    saveSession();
    chrome.storage.local.set({ lastSent: { at: Date.now(), text: text.slice(0, 200) }, netLog: [] });
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
  // One key per actual video, so the same clip isn't counted twice when Dola shows it under
  // several addresses (e.g. .../tos-alisg-v-64f990/<32-hex id>~tplv-obj.mp4 plus a ?signed copy).
  const keyOf = (url) => {
    if (!url) return '';
    if (url.startsWith('blob:')) return url;
    const id = url.match(/\/([a-f0-9]{32})(?:[~.?#]|$)/i);
    if (id) return 'id:' + id[1].toLowerCase();
    try {
      const u = new URL(url, location.href);
      return u.origin + u.pathname.replace(/~tplv-[^/]+$/i, '').replace(/\.(mp4|webm|mov)$/i, '');
    } catch (_) {
      return url.split('?')[0];
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
  function makeFilename(suffix) {
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const folder = (settings.downloadFolder || 'DolaAI').replace(/[\\:*?"<>|]+/g, ' ').trim();
    const prefix = (settings.filePrefix || 'dola').replace(/[\\/:*?"<>|]+/g, ' ').trim();
    return `${folder}/${prefix}_${stamp}${suffix}.mp4`;
  }

  async function downloadVideo(c, suffix = `_${settings.seconds}s`) {
    const filename = makeFilename(suffix);
    const duration = c.duration != null ? c.duration : videoDuration(c);
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

  // ---------- Collecting Dola's clips and joining them into one video ----------
  // Dola's Seedance 2.5 tool makes at most 15s per clip, so a 30s request arrives as
  // several clips. They are collected here and joined into one file once they add up.
  let session = null; // { id, clips: [{url, duration}], lastActivity, done }
  const IDLE_JOIN_MS = 5 * 60 * 1000;

  function saveSession() {
    chrome.storage.local.set({ clipSession: session });
  }

  // Reads a clip's length by loading only its metadata in a hidden player.
  function probeDuration(url) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      const done = (d) => { clearTimeout(t); v.removeAttribute('src'); v.load(); resolve(d); };
      const t = setTimeout(() => done(null), 20000);
      v.onloadedmetadata = () => {
        if (Number.isFinite(v.duration)) return done(v.duration);
        // Streamed files often report Infinity until you seek to the end.
        v.ondurationchange = () => { if (Number.isFinite(v.duration)) done(v.duration); };
        v.currentTime = 1e101;
      };
      v.onerror = () => done(null);
      v.src = url;
    });
  }

  async function addClip(c) {
    if (!session) session = { id: Date.now(), clips: [], lastActivity: Date.now(), done: false };
    let duration = videoDuration(c);
    if (duration == null) duration = await probeDuration(c.url);
    session.clips.push({ url: c.url, duration });
    session.lastActivity = Date.now();
    session.done = false;
    LOG('clip', session.clips.length, duration ? `${duration.toFixed(1)}s` : '(length unknown)');
    if (settings.keepParts) downloadVideo({ ...c, duration }, `_part${session.clips.length}`).catch(() => {});
    saveSession();
    await checkSession(false);
  }

  async function checkSession(force) {
    if (!session || session.done || !session.clips.length) return;
    const clips = session.clips;
    const total = clips.reduce((sum, c) => sum + (c.duration || 0), 0);
    const target = Number(settings.seconds) || 30;
    const idle = Date.now() - session.lastActivity > IDLE_JOIN_MS;
    const complete = total >= target - 1;
    if (!complete && !force && !idle) return; // more clips are probably on the way

    session.done = true;
    saveSession();
    if (clips.length === 1) {
      await downloadVideo({ url: clips[0].url, duration: clips[0].duration, el: null }, `_${Math.round(clips[0].duration || target)}s`);
      return;
    }
    const seconds = Math.round(total) || target;
    await chrome.runtime.sendMessage({
      type: 'joinClips',
      clips: clips.map((c) => ({ url: c.url, duration: c.duration })),
      filename: makeFilename(`_${seconds}s_joined`)
    });
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
      try {
        if (settings.joinClips) await addClip(c);
        else await downloadVideo(c);
      } catch (e) { LOG('download failed', e); }
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
    setInterval(() => checkSession(false).catch((e) => LOG('join error', e)), 15000);
  }
  start();

  // ---------- Popup commands ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'ping') {
      sendResponse({ ok: true, armed: Date.now() < armedUntil });
    } else if (msg.type === 'joinNow') {
      if (!session || !session.clips.length) { sendResponse({ ok: false, error: 'No clips collected yet.' }); return false; }
      session.done = false;
      checkSession(true).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    } else if (msg.type === 'fetchBlobAsDataUrl') {
      // The joiner can't read the page's blob: videos directly, so hand them over as data.
      fetch(msg.url)
        .then((r) => r.blob())
        .then((b) => new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); }))
        .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
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
