// Settings shared by the popup, background service worker and content script.
/* exported DOLA_DEFAULTS */

var DOLA_DEFAULTS = {
  // Make every video you send on Dola a single 30-second Seedance generation
  forceDuration: true,
  seconds: 30,
  appendInstruction: true,
  instruction:
    'Use Seedance 2.5. Video length: exactly {seconds} seconds as ONE single continuous {seconds}-second video (do not split it into shorter clips).',

  // Automatic download
  autoDownload: true,
  downloadFolder: 'DolaAI',
  filePrefix: 'dola',
  minVideoSeconds: 2,        // ignore tiny previews / loading animations
  waitMinutes: 20            // how long after you send a prompt to keep watching for the video
};

if (typeof module !== 'undefined') module.exports = { DOLA_DEFAULTS };
