const runBtn = document.getElementById('runBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const progressEl = document.getElementById('progress');

function renderProgress({ status, count }) {
  if (count === undefined) {
    progressEl.textContent = '';
    return;
  }
  const icon =
    status === 'done' ? '🎉' : status === 'stopped' ? '⏸' : status === 'error' ? '⚠️' : '⏳';
  const label =
    status === 'done' ? '完了!' : status === 'stopped' ? '停止中' : status === 'error' ? 'エラー' : '処理中';
  progressEl.textContent = `${icon} ${label} ${count} 本`;
}

async function getStudioTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes('studio.youtube.com')) {
    statusEl.textContent = 'YouTube Studioのタブで押してね!';
    return null;
  }
  return tab;
}

chrome.storage.local.get(['status', 'count'], (data) => {
  if (data.count !== undefined) renderProgress(data);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  chrome.storage.local.get(['status', 'count'], (data) => {
    if (data.count !== undefined) renderProgress(data);
  });
});

runBtn.addEventListener('click', async () => {
  const tab = await getStudioTab();
  if (!tab) return;

  runBtn.disabled = true;
  statusEl.textContent = '実行中... 進捗は上に出るよ';

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
    statusEl.textContent = 'スクリプト起動したよ!止めたい時は🛑停止を押してね';
  } catch (e) {
    statusEl.textContent = 'エラー: ' + e.message;
  } finally {
    runBtn.disabled = false;
  }
});

stopBtn.addEventListener('click', async () => {
  const tab = await getStudioTab();
  if (!tab) return;

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      window.__ytDraftBulkStop = true;
    }
  });
  statusEl.textContent = '停止リクエストを送ったよ。今処理中の1本が終わり次第止まるよ';
});
