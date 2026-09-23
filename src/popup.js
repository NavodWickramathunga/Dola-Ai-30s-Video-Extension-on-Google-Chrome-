/* global DOLA_DEFAULTS, buildClipPrompts */
const $ = (sel) => document.querySelector(sel);
const settingEls = [...document.querySelectorAll('[data-setting]')];
let settings = { ...DOLA_DEFAULTS };

const STATUS_LABEL = {
  starting: 'Starting…',
  running: 'Generating on Dola…',
  generated: 'All parts generated',
  merging: 'Stitching…',
  done: 'Done ✓',
  error: 'Error',
  stopped: 'Stopped'
};
const CLIP_LABEL = { queued: 'waiting', sending: 'sending prompt', generating: 'generating…', done: 'done', error: 'error' };
const ACTIVE = ['starting', 'running', 'generated', 'merging'];

async function loadSettings() {
  const { settings: saved, draftPrompt } = await chrome.storage.local.get(['settings', 'draftPrompt']);
  settings = { ...DOLA_DEFAULTS, ...(saved || {}) };
  for (const el of settingEls) {
    const v = settings[el.dataset.setting];
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  }
  if (draftPrompt) $('#prompt').value = draftPrompt;
  syncModeUi();
}

function readSetting(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'number') return Number(el.value);
  return el.value;
}

async function saveSettings() {
  for (const el of settingEls) settings[el.dataset.setting] = readSetting(el);
  await chrome.storage.local.set({ settings });
  syncModeUi();
}

function syncModeUi() {
  $('#clipSeconds').disabled = settings.mode === 'single';
}

function renderJob(job) {
  const box = $('#jobBox');
  if (!job) { box.hidden = true; return; }
  box.hidden = false;
  $('#jobStatus').textContent = STATUS_LABEL[job.status] || job.status;
  $('#jobMessage').textContent = job.message || '';
  const list = $('#clipList');
  list.replaceChildren(
    ...job.clips.map((c) => {
      const li = document.createElement('li');
      li.className = `st-${c.status}`;
      let text = `Part ${c.part}/${c.total} (${c.seconds}s): ${CLIP_LABEL[c.status] || c.status}`;
      if (c.status === 'done') text += c.downloaded ? ' · saving to Downloads' : '';
      if (c.error) text += ` · ${c.error}`;
      li.textContent = text;
      if (c.url) {
        const a = document.createElement('a');
        a.href = c.url;
        a.target = '_blank';
        a.textContent = 'open';
        a.className = 'open';
        li.append(a);
      }
      return li;
    })
  );
  if (job.merged) {
    const li = document.createElement('li');
    li.className = 'st-done';
    li.textContent = `Full video: ${job.merged}`;
    list.append(li);
  }
  // A job that hasn't reported progress for 15 min is considered dead, so Start is usable again.
  const active = ACTIVE.includes(job.status) && Date.now() - (job.updatedAt || 0) < 15 * 60 * 1000;
  $('#start').disabled = active;
  $('#stop').hidden = !['starting', 'running'].includes(job.status);
}

function renderPreview() {
  const prompt = $('#prompt').value.trim();
  const box = $('#previewBox');
  if (!prompt) { box.hidden = true; return; }
  const clips = buildClipPrompts(prompt, settings);
  $('#previewList').replaceChildren(
    ...clips.map((c) => {
      const div = document.createElement('div');
      div.className = 'pv';
      div.textContent = `— Part ${c.part}/${c.total} · ${c.seconds}s —\n${c.prompt}`;
      return div;
    })
  );
  box.hidden = false;
}

settingEls.forEach((el) => el.addEventListener('change', async () => {
  await saveSettings();
  if (!$('#previewBox').hidden) renderPreview();
}));

$('#prompt').addEventListener('input', () => chrome.storage.local.set({ draftPrompt: $('#prompt').value }));

$('#preview').addEventListener('click', () => {
  if (!$('#previewBox').hidden) { $('#previewBox').hidden = true; return; }
  renderPreview();
});

$('#start').addEventListener('click', async () => {
  const prompt = $('#prompt').value.trim();
  if (!prompt) { $('#prompt').focus(); return; }
  await saveSettings();
  $('#start').disabled = true;
  await chrome.runtime.sendMessage({ type: 'startJob', prompt });
});

$('#stop').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'stopJob' }));

$('#reset').addEventListener('click', async () => {
  await chrome.storage.local.set({ settings: { ...DOLA_DEFAULTS } });
  await loadSettings();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.job) renderJob(changes.job.newValue);
});

(async () => {
  await loadSettings();
  const { job } = await chrome.storage.local.get('job');
  renderJob(job);
})();
