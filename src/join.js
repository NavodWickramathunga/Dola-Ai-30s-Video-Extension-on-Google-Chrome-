// Joins Dola's clips into one continuous video: plays them back to back into a canvas
// (picture) and a WebAudio stream (sound) and records the result with MediaRecorder.
(async () => {
  const statusEl = document.getElementById('status');
  const barEl = document.getElementById('bar');
  const canvas = document.getElementById('canvas');
  const player = document.getElementById('player');
  const ctx2d = canvas.getContext('2d');
  const setStatus = (t) => { statusEl.textContent = t; };

  function pickMime() {
    const options = [
      ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'mp4'],
      ['video/mp4;codecs=avc1,mp4a', 'mp4'],
      ['video/mp4', 'mp4'],
      ['video/webm;codecs=vp9,opus', 'webm'],
      ['video/webm', 'webm']
    ];
    return options.find(([m]) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || ['video/webm', 'webm'];
  }

  async function loadClip(url, tabId, n) {
    if (url.startsWith('blob:')) {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'fetchBlobAsDataUrl', url });
      if (!res || !res.ok) throw new Error(`Clip ${n}: ${res ? res.error : 'the Dola tab is closed'}`);
      return (await fetch(res.dataUrl)).blob();
    }
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Clip ${n} could not be downloaded (HTTP ${r.status})`);
    return r.blob();
  }

  function waitFor(el, event) {
    return new Promise((resolve, reject) => {
      el.addEventListener(event, resolve, { once: true });
      el.addEventListener('error', () => reject(new Error('A clip could not be played.')), { once: true });
    });
  }

  function drawFrame() {
    const vw = player.videoWidth, vh = player.videoHeight;
    if (!vw || !vh) return;
    const scale = Math.min(canvas.width / vw, canvas.height / vh);
    const w = vw * scale, h = vh * scale;
    ctx2d.fillStyle = '#000';
    ctx2d.fillRect(0, 0, canvas.width, canvas.height);
    ctx2d.drawImage(player, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  }

  async function playClip(url, onProgress) {
    player.src = url;
    await waitFor(player, 'loadedmetadata');
    const ended = waitFor(player, 'ended');
    let running = true;
    const loop = () => {
      if (!running) return;
      drawFrame();
      onProgress(player.currentTime / (player.duration || 1));
      player.requestVideoFrameCallback(loop);
    };
    player.requestVideoFrameCallback(loop);
    await player.play();
    await ended;
    running = false;
    drawFrame();
  }

  let job;
  try {
    ({ joinJob: job } = await chrome.storage.local.get('joinJob'));
    if (!job || !job.clips || job.clips.length < 2) throw new Error('No clips to join.');

    const urls = [];
    for (let i = 0; i < job.clips.length; i++) {
      setStatus(`Downloading clip ${i + 1} of ${job.clips.length}…`);
      urls.push(URL.createObjectURL(await loadClip(job.clips[i].url, job.tabId, i + 1)));
    }

    // Output size = size of the first clip.
    player.src = urls[0];
    await waitFor(player, 'loadedmetadata');
    canvas.width = player.videoWidth || 1080;
    canvas.height = player.videoHeight || 1920;

    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaElementSource(player);
    const dest = audioCtx.createMediaStreamDestination();
    source.connect(dest);
    const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const [mime, ext] = pickMime();
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((r) => { recorder.onstop = r; });

    await Promise.race([audioCtx.resume(), new Promise((r) => setTimeout(r, 1000))]);
    if (audioCtx.state !== 'running') {
      // Chrome blocked autoplay: one click is needed.
      const btn = document.getElementById('start');
      btn.hidden = false;
      setStatus('Click "Start joining" to continue.');
      await new Promise((r) => btn.addEventListener('click', r, { once: true }));
      btn.hidden = true;
      await audioCtx.resume();
    }

    recorder.start(1000);
    for (let i = 0; i < urls.length; i++) {
      setStatus(`Joining clip ${i + 1} of ${urls.length}…`);
      await playClip(urls[i], (p) => { barEl.style.width = `${((i + p) / urls.length) * 100}%`; });
    }
    barEl.style.width = '100%';
    recorder.stop();
    await stopped;
    urls.forEach((u) => URL.revokeObjectURL(u));

    const filename = job.filename.replace(/\.mp4$/, `.${ext}`);
    const out = URL.createObjectURL(new Blob(chunks, { type: mime.split(';')[0] }));
    await chrome.downloads.download({ url: out, filename, conflictAction: 'uniquify', saveAs: false });
    const total = job.clips.reduce((s, c) => s + (c.duration || 0), 0);

    const { history = [] } = await chrome.storage.local.get('history');
    history.unshift({ at: Date.now(), filename, duration: total || null, ok: true, joined: job.clips.length });
    await chrome.storage.local.set({ history: history.slice(0, 20), joinJob: null });
    chrome.runtime.sendMessage({ type: 'joinDone', filename });
    setStatus(`Done! Saved to Downloads/${filename}. This tab will close in a few seconds.`);
    setTimeout(async () => {
      if (job.tabId) { try { await chrome.tabs.update(job.tabId, { active: true }); } catch (_) { /* tab gone */ } }
      window.close();
    }, 4000);
  } catch (e) {
    console.error(e);
    setStatus(`Joining failed: ${e.message}`);
    const { history = [] } = await chrome.storage.local.get('history');
    history.unshift({ at: Date.now(), filename: (job && job.filename) || 'joined video', ok: false, error: `joining failed: ${e.message}` });
    await chrome.storage.local.set({ history: history.slice(0, 20) });
  }
})();
