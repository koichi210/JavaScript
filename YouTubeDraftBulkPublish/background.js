chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'progress') {
    chrome.action.setBadgeText({ text: String(msg.count) });
    chrome.action.setBadgeBackgroundColor({ color: '#3ea6ff' });
  } else if (msg.type === 'done') {
    chrome.action.setBadgeText({ text: '✓' + msg.count });
    chrome.action.setBadgeBackgroundColor({ color: '#3fb950' });
  } else if (msg.type === 'stopped') {
    chrome.action.setBadgeText({ text: '⏸' + msg.count });
    chrome.action.setBadgeBackgroundColor({ color: '#e0a336' });
  } else if (msg.type === 'error') {
    chrome.action.setBadgeText({ text: '!' + msg.count });
    chrome.action.setBadgeBackgroundColor({ color: '#e05252' });
  } else if (msg.type === 'reset') {
    chrome.action.setBadgeText({ text: '' });
  }
});
