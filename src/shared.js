// Shared between popup, background service worker and content script.
/* exported DOLA_DEFAULTS, buildClipPrompts, splitScenes */

var DOLA_DEFAULTS = {
  // Generation
  mode: 'chain',            // 'chain' = N clips that add up to totalSeconds, 'single' = one request
  totalSeconds: 30,
  clipSeconds: 10,
  aspectRatio: '9:16',
  resolution: '1080p',
  style: 'cinematic, photorealistic, smooth camera motion',
  skillPrefix: 'Use Seedance 2.5 to',
  chainTemplate:
    '{skill} generate a {seconds}-second video, aspect ratio {ratio}, {resolution}, style: {style}. ' +
    'This is part {part} of {total} of ONE continuous {totalSeconds}-second video, so keep the exact same ' +
    'characters, outfits, location, lighting, colour grade and camera style as the other parts.\n\n' +
    'Full story: {prompt}\n\nPart {part} shows: {beat}',
  singleTemplate:
    '{skill} generate a {seconds}-second video, aspect ratio {ratio}, {resolution}, style: {style}.\n\n{prompt}',

  // Download
  autoDownload: true,
  downloadFolder: 'DolaAI',
  filePrefix: 'dola',
  mergeClips: true,          // stitch chained clips into one 30s file
  watchMode: false,          // download every new video that appears on dola.com, even outside a job

  // Automation tuning
  clipTimeoutMin: 12,
  minVideoSeconds: 2,
  inputSelector: '',         // optional CSS override for the prompt box
  sendSelector: '',          // optional CSS override for the send button
  newChatPerJob: false,
  dolaUrl: 'https://www.dola.com/chat/'
};

// If the prompt already lists scenes ("1. ...", "Scene 2: ...", "---" or one per line),
// use them as beats for the individual clips.
function splitScenes(prompt) {
  const text = prompt.trim();
  let parts = text.split(/\n\s*-{3,}\s*\n/);
  if (parts.length > 1) return parts.map((p) => p.trim()).filter(Boolean);
  const MARKER = /^\s*(?:\d+[.)]|scene\s*\d+|part\s*\d+|shot\s*\d+)\s*[:.)-]?\s/i;
  parts = text.split(/\n(?=\s*(?:\d+[.)]|scene\s*\d+|part\s*\d+|shot\s*\d+)\s*[:.)-]?\s)/i);
  if (parts.length > 1) {
    // Text before "1." is an intro that already lives in {prompt}, not a scene of its own.
    if (!MARKER.test(parts[0])) parts.shift();
    return parts
      .map((p) => p.replace(/^\s*(?:\d+[.)]|scene\s*\d+|part\s*\d+|shot\s*\d+)\s*[:.)-]?\s*/i, '').trim())
      .filter(Boolean);
  }
  return [];
}

function genericBeat(i, total) {
  if (total === 1) return 'the whole story from beginning to end';
  if (i === 0) return 'the opening: establish the setting and main subject with a strong hook in the first second';
  if (i === total - 1) return 'the climax and satisfying ending, continuing directly from the previous part';
  return 'the middle of the story, continuing directly from the previous part and building up the action';
}

function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

// Returns [{ part, total, seconds, prompt }]
function buildClipPrompts(userPrompt, s) {
  const base = {
    skill: (s.skillPrefix || '').trim(),
    ratio: s.aspectRatio,
    resolution: s.resolution,
    style: s.style,
    prompt: userPrompt.trim(),
    totalSeconds: s.totalSeconds
  };
  const clean = (t) => t.replace(/^\s+/, '').replace(/^(.)/, (c) => c.toUpperCase());

  if (s.mode === 'single') {
    return [{
      part: 1,
      total: 1,
      seconds: s.totalSeconds,
      prompt: clean(fill(s.singleTemplate, { ...base, seconds: s.totalSeconds }))
    }];
  }

  const clipSeconds = Math.max(1, Number(s.clipSeconds) || 10);
  const total = Math.max(1, Math.ceil(Number(s.totalSeconds) / clipSeconds));
  const scenes = splitScenes(userPrompt);
  const clips = [];
  for (let i = 0; i < total; i++) {
    const seconds = i === total - 1 ? s.totalSeconds - clipSeconds * (total - 1) : clipSeconds;
    let beat;
    if (scenes.length === total) beat = scenes[i];
    else if (scenes.length > 0) {
      // Spread scenes over the clips.
      const from = Math.floor((i * scenes.length) / total);
      const to = Math.max(from + 1, Math.floor(((i + 1) * scenes.length) / total));
      beat = scenes.slice(from, to).join(' Then ');
    } else beat = genericBeat(i, total);
    clips.push({
      part: i + 1,
      total,
      seconds,
      prompt: clean(fill(s.chainTemplate, { ...base, seconds, part: i + 1, total, beat }))
    });
  }
  return clips;
}

if (typeof module !== 'undefined') module.exports = { DOLA_DEFAULTS, buildClipPrompts, splitScenes };
