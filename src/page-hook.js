// Runs in the page's own JS world (MAIN) on dola.com.
// Watches fetch / XHR / EventSource traffic for video URLs so the content script
// can find the generated Seedance video even when it isn't a plain <video> tag yet.
(() => {
  if (window.__dolaVideoHookInstalled) return;
  window.__dolaVideoHookInstalled = true;

  const VIDEO_URL_RE = /https?:\\?\/\\?\/[^"'\s<>\\]+?\.(?:mp4|webm|mov|m3u8)(?:\?[^"'\s<>\\]*)?/gi;
  const seen = new Set();

  function report(text) {
    if (!text || typeof text !== 'string') return;
    const matches = text.match(VIDEO_URL_RE);
    if (!matches) return;
    for (let raw of matches) {
      const url = raw
        .replace(/\\\//g, '/')
        .replace(/\\u0026/gi, '&')
        .replace(/&amp;/g, '&');
      if (seen.has(url)) continue;
      seen.add(url);
      window.postMessage({ source: 'dola-video-hook', type: 'video-url', url }, '*');
    }
  }

  function looksTextual(contentType) {
    return !contentType || /json|text|event-stream|javascript/i.test(contentType);
  }

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      if (looksTextual(res.headers.get('content-type'))) {
        const clone = res.clone();
        if (clone.body && clone.body.getReader) {
          // Read streamed (SSE) responses incrementally.
          const reader = clone.body.getReader();
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
        } else {
          clone.text().then(report).catch(() => {});
        }
      }
    } catch (_) { /* never break the page */ }
    return res;
  };

  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      try {
        if (this.responseType === '' || this.responseType === 'text') report(this.responseText);
        else if (this.responseType === 'json') report(JSON.stringify(this.response));
      } catch (_) { /* ignore */ }
    });
    return origSend.apply(this, args);
  };

  if (window.EventSource) {
    const OrigES = window.EventSource;
    window.EventSource = function (...args) {
      const es = new OrigES(...args);
      es.addEventListener('message', (e) => report(e.data));
      return es;
    };
    window.EventSource.prototype = OrigES.prototype;
  }
})();
