// Joins the downloaded Seedance clips into one continuous video by playing them into a
// canvas + WebAudio graph and recording the result with MediaRecorder.
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
      ['video/webm;codecs=vp8,opus', 'webm'],
      ['video/webm', 'webm']
    ];
    return options.find(([m]) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || ['video/webm', 'webm'];
  }

  async function loadClip(clip, tabId) {
    if (clip.url.startsWith('blob:')) {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'fetchBlobAsDataUrl', url: clip.url });
      if (!res || !res.ok) throw new Error(`Part ${clip.part}: ${res ? res.error : 'Dola tab not reachable'}`);
      return (await fetch(res.dataUrl)).blob();
    }
    const r = await fetch(clip.url);
    if (!r.ok) throw new Error(`Part ${clip.part}: HTTP ${r.status}`);
    return r.blob();
  }

  function playInto(url, onFrame) {
    return new Promise((resolve, reject) => {
      player.src = url;
      player.onerror = () => reject(new Error('A clip could not be decoded.'));
      player.onended = () => resolve();
      player.onloadedmetadata = () => player.play().catch(reject);
      const draw = () => {
        if (player.ended) return;
        onFrame();
        player.requestVideoFrameCallback(draw);
      };
      player.requestVideoFrameCallback(draw);
    });
  }

  function drawContain() {
    const vw = player.videoWidth, vh = player.videoHeight;
    if (!vw || !vh) return;
    const scale = Math.min(canvas.width / vw, canvas.height / vh);
    const w = vw * scale, h = vh * scale;
    ctx2d.fillStyle = '#000';
    ctx2d.fillRect(0, 0, canvas.width, canvas.height);
    ctx2d.drawImage(player, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  }

  try {
    const { job } = await chrome.storage.local.get('job');
    if (!job || !job.clips) throw new Error('No finished job found.');
    const clips = job.clips.filter((c) => c.url);
    if (clips.length < 2) throw new Error('Need at least two generated clips to stitch.');

    const blobUrls = [];
    for (let i = 0; i < clips.length; i++) {
      setStatus(`Fetching part ${i + 1} of ${clips.length}…`);
      blobUrls.push(URL.createObjectURL(await loadClip(clips[i], job.tabId)));
    }

    // Size the canvas from the first clip.
    await new Promise((res, rej) => {
      player.src = blobUrls[0];
      player.onloadedmetadata = res;
      player.onerror = () => rej(new Error('Part 1 could not be decoded.'));
    });
    canvas.width = player.videoWidth || 1080;
    canvas.height = player.videoHeight || 1920;

    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaElementSource(player);
    const dest = audioCtx.createMediaStreamDestination();
    source.connect(dest);

    const stream = new MediaStream([
      ...canvas.captureStream(30).getVideoTracks(),
      ...dest.stream.getAudioTracks()
    ]);
    const [mime, ext] = pickMime();
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((r) => { recorder.onstop = r; });

    await Promise.race([audioCtx.resume(), new Promise((r) => setTimeout(r, 1000))]);
    if (audioCtx.state !== 'running') {
      // Autoplay blocked: need one click from the user.
      const btn = document.getElementById('start');
      btn.hidden = false;
      setStatus('Click "Start stitching" to continue.');
      await new Promise((r) => btn.addEventListener('click', r, { once: true }));
      btn.hidden = true;
      await audioCtx.resume();
    }
    recorder.start(1000);
    for (let i = 0; i < blobUrls.length; i++) {
      setStatus(`Recording part ${i + 1} of ${blobUrls.length}…`);
      barEl.style.width = `${(i / blobUrls.length) * 100}%`;
      await playInto(blobUrls[i], drawContain);
    }
    barEl.style.width = '100%';
    recorder.stop();
    await stopped;

    const out = new Blob(chunks, { type: mime.split(';')[0] });
    const outUrl = URL.createObjectURL(out);
    const filename = `${job.folder}/${job.baseName}_FULL.${ext}`;
    await chrome.downloads.download({ url: outUrl, filename, conflictAction: 'uniquify', saveAs: false });
    setStatus(`Saved to Downloads/${filename}. You can close this tab.`);
    chrome.runtime.sendMessage({ type: 'mergeDone', filename });
    blobUrls.forEach((u) => URL.revokeObjectURL(u));
  } catch (e) {
    console.error(e);
    setStatus(`Stitching failed: ${e.message}. The individual parts were still downloaded.`);
    chrome.runtime.sendMessage({ type: 'mergeFailed', error: e.message });
  }
})();
