// Service worker: saves finished videos, opens the joiner, and shows notifications.

function notify(title, message) {
  chrome.notifications.create(
    { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title, message },
    () => void chrome.runtime.lastError
  );
}

function flashBadge() {
  chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' });
  chrome.action.setBadgeText({ text: '✓' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 15000);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'download') {
    chrome.downloads
      .download({ url: msg.url, filename: msg.filename, conflictAction: 'uniquify', saveAs: false })
      .then((id) => {
        const len = msg.duration ? ` (${Math.round(msg.duration)}s)` : '';
        notify('Dola video downloaded', `Saved to Downloads/${msg.filename}${len}`);
        flashBadge();
        sendResponse({ ok: true, id });
      })
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'joinClips') {
    // The joiner plays the clips back to back and records them, so it needs a visible tab.
    const job = { clips: msg.clips, filename: msg.filename, tabId: sender.tab && sender.tab.id, at: Date.now() };
    chrome.storage.local
      .set({ joinJob: job })
      .then(() => chrome.tabs.create({ url: chrome.runtime.getURL('src/join.html'), active: true }))
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'joinDone') {
    notify('Your 30s video is ready', `Saved to Downloads/${msg.filename}`);
    flashBadge();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
