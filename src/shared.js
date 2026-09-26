// Settings shared by the popup, background service worker and content script.
/* exported DOLA_DEFAULTS, withDefaults */

var DOLA_DEFAULTS = {
  // What to ask Dola for (added as visible text to your message; Dola's requests are never modified)
  seconds: 30,
  appendInstruction: true,
  // Dola's Seedance 2.5 tool makes at most 15s per clip, so ask for consecutive clips that
  // continue each other; the extension then joins them into one 30s file.
  instruction:
    'Use Seedance 2.5. Total video length: {seconds} seconds, 9:16 unless I said otherwise. ' +
    'If one clip cannot be {seconds} seconds, make consecutive 15-second clips where each clip ' +
    'starts exactly on the last frame of the previous one (same characters, camera, lighting and style) ' +
    'so they join into one seamless {seconds}-second video. Do not ask me to confirm the plan: generate all clips now.',

  // Automatic download
  autoDownload: true,
  joinClips: true,           // join Dola's clips into one video of `seconds` length
  keepParts: false,          // also save the separate clips
  downloadFolder: 'DolaAI',
  filePrefix: 'dola',
  minVideoSeconds: 2,        // ignore tiny previews / loading animations
  waitMinutes: 30            // how long after you send a prompt to keep watching for the video
};

// Earlier default instructions, replaced automatically when the saved setting still equals one.
var OLD_DEFAULT_INSTRUCTIONS = [
  'Use Seedance 2.5. Video length: exactly {seconds} seconds as ONE single continuous {seconds}-second video (do not split it into shorter clips).'
];

function withDefaults(saved) {
  const s = { ...DOLA_DEFAULTS, ...(saved || {}) };
  if (OLD_DEFAULT_INSTRUCTIONS.includes(s.instruction)) s.instruction = DOLA_DEFAULTS.instruction;
  return s;
}

if (typeof module !== 'undefined') module.exports = { DOLA_DEFAULTS, withDefaults };
