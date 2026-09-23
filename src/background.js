// Service worker: saves finished videos with chrome.downloads and shows a notification.

function notify(title, message) {
  chrome.notifications.create(
    { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title, message },
    () => void chrome.runtime.lastError
  );
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'download') return false;
  chrome.downloads
    .download({ url: msg.url, filename: msg.filename, conflictAction: 'uniquify', saveAs: false })
    .then((id) => {
      const len = msg.duration ? ` (${Math.round(msg.duration)}s)` : '';
      notify('Dola video downloaded', `Saved to Downloads/${msg.filename}${len}`);
      chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' });
      chrome.action.setBadgeText({ text: '✓' });
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 15000);
      sendResponse({ ok: true, id });
    })
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true;
});
