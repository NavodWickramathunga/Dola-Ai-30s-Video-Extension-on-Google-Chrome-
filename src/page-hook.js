// Runs in the page's own JS world (MAIN) on dola.com.
//
// 1. When you send a prompt, it finds the request that carries your prompt and
//    - sets any video-duration field in it to 30 seconds, and
//    - appends the "one single 30-second video" instruction to your prompt text.
// 2. It watches fetch / XHR / EventSource responses for video URLs so the content
//    script can find and download the finished video.
(() => {
  if (window.__dolaVideoHookInstalled) return;
  window.__dolaVideoHookInstalled = true;

  const post = (msg) => window.postMessage({ source: 'dola-video-hook', ...msg }, '*');

  // ---------- Config + the prompt you are sending (from content.js) ----------
  let config = { forceDuration: true, seconds: 30, appendInstruction: true, instructionText: '' };
  let pending = null; // { text, at }
  const PENDING_WINDOW_MS = 20000;

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'dola-video-content') return;
    if (e.data.type === 'config') config = { ...config, ...e.data.config };
  });
  // Sent with a synchronous DOM event (not postMessage) so it arrives before Dola's own
  // send handler fires the network request.
  document.addEventListener('dola-video-pending', (e) => {
    if (typeof e.detail === 'string' && e.detail.trim()) pending = { text: e.detail, at: Date.now() };
  }, true);

  // ---------- Request rewriting ----------
  const DURATION_KEY_RE =
    /^(duration|video_?duration|gen_?duration|target_?duration|duration_?(s|sec|secs|second|seconds)|seconds|video_?seconds|video_?length|length_?seconds|clip_?duration)$/i;
  const DURATION_MS_KEY_RE = /^(duration_?ms|video_?duration_?ms|duration_?millis(econds)?)$/i;

  // Letters/digits only, so JSON escaping (\n, \", …) doesn't stop us matching the prompt.
  const norm = (s) => s.replace(/\\[nrt"\\/]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
  const promptKey = (text) => norm(text).slice(0, 30);

  function rewriteValue(value, target) {
    if (typeof value === 'number') return value === target ? null : target;
    if (typeof value === 'string') {
      const m = value.match(/^(\d+(?:\.\d+)?)(\s*s(?:ec(?:onds?)?)?)?$/i);
      if (!m) return null;
      const next = `${target}${m[2] || ''}`;
      return next === value ? null : next;
    }
    return null;
  }

  // Walks the JSON, returns a list of human-readable changes (mutates obj).
  function rewriteObject(obj, needle, changes, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 12) return;
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (config.forceDuration && DURATION_KEY_RE.test(key)) {
        const next = rewriteValue(val, config.seconds);
        if (next !== null) { changes.push(`${key}: ${val} → ${next}`); obj[key] = next; continue; }
      }
      if (config.forceDuration && DURATION_MS_KEY_RE.test(key)) {
        const next = rewriteValue(val, config.seconds * 1000);
        if (next !== null) { changes.push(`${key}: ${val} → ${next}`); obj[key] = next; continue; }
      }
      if (typeof val === 'string') {
        // Some APIs nest JSON inside a string field.
        const t = val.trim();
        if ((t.startsWith('{') || t.startsWith('[')) && t.length < 200000) {
          try {
            const inner = JSON.parse(t);
            const before = changes.length;
            rewriteObject(inner, needle, changes, depth + 1);
            if (changes.length > before) obj[key] = JSON.stringify(inner);
            continue;
          } catch (_) { /* not JSON */ }
        }
        if (
          config.appendInstruction &&
          config.instructionText &&
          needle &&
          norm(val).includes(needle) &&
          !val.includes(config.instructionText)
        ) {
          obj[key] = `${val}\n\n${config.instructionText}`;
          changes.push(`added 30s instruction to "${key}"`);
        }
      } else if (val && typeof val === 'object') {
        rewriteObject(val, needle, changes, depth + 1);
      }
    }
  }

  // ---------- Diagnostics: what did the page send right after you pressed send? ----------
  // Only request metadata is recorded (address path, method, body type/size, key names),
  // never the values, so the popup can show why a prompt was or wasn't changed.
  function keyPaths(obj, prefix = '', out = [], depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 6 || out.length > 60) return out;
    for (const k of Object.keys(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      out.push(path);
      const v = obj[k];
      if (v && typeof v === 'object') keyPaths(v, Array.isArray(obj) ? prefix : path, out, depth + 1);
      else if (typeof v === 'string' && /^\s*[{[]/.test(v)) {
        try { keyPaths(JSON.parse(v), path, out, depth + 1); } catch (_) { /* not JSON */ }
      }
    }
    return out;
  }
  function logRequest(transport, method, url, kind, text, changed) {
    if (!pending || Date.now() - pending.at > PENDING_WINDOW_MS) return;
    let path = String(url || '');
    try { const u = new URL(path, location.href); path = u.host + u.pathname; } catch (_) { /* keep */ }
    const needle = promptKey(pending.text);
    const hasPrompt = !!(text && needle.length >= 4 && norm(text).includes(needle));
    let keys = [];
    if (hasPrompt) {
      try { keys = keyPaths(JSON.parse(text.trim())).slice(0, 60); } catch (_) { /* not JSON */ }
    }
    post({ type: 'net-log', entry: { at: Date.now(), transport, method, path, kind, size: text ? text.length : 0, hasPrompt, changed: !!changed, keys } });
  }

  function bodyKind(body) {
    if (body == null) return 'none';
    if (typeof body === 'string') return 'text';
    if (body instanceof URLSearchParams) return 'form';
    if (body instanceof FormData) return 'multipart';
    if (body instanceof Blob) return 'blob';
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return 'binary';
    if (body instanceof ReadableStream) return 'stream';
    return typeof body;
  }
  // Best-effort, synchronous conversion of a request body to text.
  function bodyText(body) {
    try {
      if (typeof body === 'string') return body;
      if (body instanceof URLSearchParams) return body.toString();
      if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
      if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
      if (body instanceof FormData) {
        return [...body.entries()].map(([k, v]) => (typeof v === 'string' ? `${k}=${v}` : k)).join('\n');
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  // Returns the new body string, or null to leave the request untouched.
  function maybeRewriteText(text) {
    if (typeof text !== 'string' || !pending || Date.now() - pending.at > PENDING_WINDOW_MS) return null;
    if (!config.forceDuration && !config.appendInstruction) return null;
    const needle = promptKey(pending.text);
    // Only touch the request that actually carries the prompt you just sent.
    if (needle.length < 4 || !norm(text).includes(needle)) return null;
    const t = text.trim();
    const changes = [];
    if (t.startsWith('{') || t.startsWith('[')) {
      let json;
      try { json = JSON.parse(t); } catch (_) { return null; }
      rewriteObject(json, needle, changes);
      if (!changes.length) return null;
      post({ type: 'rewrote', changes });
      return JSON.stringify(json);
    }
    return null;
  }

  // Rewrites the body if it carries your prompt; returns the (possibly new) body.
  function handleBody(transport, method, url, body) {
    const kind = bodyKind(body);
    const text = bodyText(body);
    let next = null;
    if (text !== null) {
      next = maybeRewriteText(text);
      if (next !== null && body instanceof URLSearchParams) next = null; // JSON only
    }
    logRequest(transport, method, url, kind, text, next !== null);
    if (next === null) return body;
    if (kind === 'binary') return new TextEncoder().encode(next);
    return next;
  }

  // ---------- Video URL detection ----------
  const VIDEO_URL_RE = /https?:\\?\/\\?\/[^"'\s<>\\]+?\.(?:mp4|webm|mov|m3u8)(?:\?[^"'\s<>\\]*)?/gi;
  const seen = new Set();
  function report(text) {
    if (!text || typeof text !== 'string') return;
    const matches = text.match(VIDEO_URL_RE);
    if (!matches) return;
    for (const raw of matches) {
      const url = raw.replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/g, '&');
      if (seen.has(url)) continue;
      seen.add(url);
      post({ type: 'video-url', url });
    }
  }
  const looksTextual = (ct) => !ct || /json|text|event-stream|javascript/i.test(ct);

  // ---------- fetch ----------
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    try {
      const url = input && input.url ? input.url : input;
      const method = (init && init.method) || (input instanceof Request ? input.method : 'GET');
      if (pending && init && 'body' in init && init.body != null) {
        let body = init.body;
        if (body instanceof Blob) body = await body.text();
        const next = handleBody('fetch', method, url, body);
        if (next !== body) init = { ...init, body: next };
      } else if (pending && input instanceof Request && input.method !== 'GET' && !(init && 'body' in init)) {
        const text = await input.clone().text();
        const next = handleBody('fetch', method, url, text);
        if (next !== text) input = new Request(input, { body: next });
      }
    } catch (_) { /* never break the page */ }

    const res = await origFetch.call(this, input, init);
    try {
      if (looksTextual(res.headers.get('content-type')) && res.body) {
        const reader = res.clone().body.getReader();
        const decoder = new TextDecoder();
        let tail = '';
        (async () => {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = tail + decoder.decode(value, { stream: true });
              report(chunk);
              tail = chunk.slice(-2048);
            }
          } catch (_) { /* ignore */ }
        })();
      }
    } catch (_) { /* ignore */ }
    return res;
  };

  // ---------- XHR ----------
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__dolaUrl = url;
    this.__dolaMethod = method;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (pending) body = handleBody('xhr', this.__dolaMethod || 'POST', this.__dolaUrl, body);
    } catch (_) { /* ignore */ }
    this.addEventListener('load', () => {
      try {
        if (this.responseType === '' || this.responseType === 'text') report(this.responseText);
        else if (this.responseType === 'json') report(JSON.stringify(this.response));
      } catch (_) { /* ignore */ }
    });
    return origSend.call(this, body);
  };

  // ---------- WebSocket (some chat apps send messages this way) ----------
  if (window.WebSocket) {
    const origWsSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        if (pending) data = handleBody('websocket', 'SEND', this.url, data);
      } catch (_) { /* ignore */ }
      return origWsSend.call(this, data);
    };
    const OrigWS = window.WebSocket;
    window.WebSocket = function (...args) {
      const ws = new OrigWS(...args);
      ws.addEventListener('message', (e) => { if (typeof e.data === 'string') report(e.data); });
      return ws;
    };
    window.WebSocket.prototype = OrigWS.prototype;
    Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  }

  // ---------- EventSource ----------
  if (window.EventSource) {
    const OrigES = window.EventSource;
    window.EventSource = function (...args) {
      const es = new OrigES(...args);
      es.addEventListener('message', (e) => report(e.data));
      return es;
    };
    window.EventSource.prototype = OrigES.prototype;
  }

  post({ type: 'hook-ready' });
})();
