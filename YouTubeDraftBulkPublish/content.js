(function () {
  // manifestのcontent_scriptsで毎ページ自動注入されるようになったので、二重実行だけ防ぐ
  if (window.__ytDraftBulkInjected) return;
  window.__ytDraftBulkInjected = true;
  window.__ytDraftBulkStop = false;

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // すべてのポーリングはここを通す。timeout秒経ったら必ずタイマーを止めて諦める(ゾンビタイマー防止)
  function waitFor(checkFn, { timeout = 8000, interval = 300 } = {}) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        tryRecoverError();
        let result;
        try {
          result = checkFn();
        } catch (e) {
          result = null;
        }
        if (result) {
          clearInterval(timer);
          resolve(result);
        } else if (Date.now() - start > timeout) {
          clearInterval(timer);
          reject(new Error('タイムアウトした(' + timeout + 'ms待っても見つからなかった)'));
        }
      }, interval);
    });
  }

  function findDraftRows() {
    return [...document.querySelectorAll('ytcp-video-row')].filter((row) =>
      row.textContent.includes('ドラフト')
    );
  }

  function clickRow(row) {
    const link = row.querySelector('#video-title') || row.querySelector('a[href]') || row;
    link.click();
  }

  function isVisible(el) {
    return !!(el.offsetParent || (el.getClientRects && el.getClientRects().length));
  }

  function checkStop() {
    if (window.__ytDraftBulkStop) {
      throw new Error('__stopped_by_user__');
    }
  }

  // YouTube側が「予期しない問題が発生しました」を出してきたら再試行を自動で押す
  function tryRecoverError() {
    const retryBtn = [...document.querySelectorAll('button, ytcp-button')].find(
      (b) => b.textContent.trim() === '再試行' && isVisible(b)
    );
    if (retryBtn) {
      retryBtn.click();
      console.log('  ⚠️ 「予期しない問題が発生しました」を検知、再試行を押した');
      return true;
    }
    return false;
  }

  function findNextPageButton() {
    const candidates = [
      ...document.querySelectorAll('button, ytcp-icon-button, ytcp-button, paper-icon-button'),
    ];
    return candidates.find((b) => {
      if (b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      const id = (b.id || '').toLowerCase();
      return (
        id.includes('navigate-after') ||
        id.includes('next-page') ||
        aria.includes('next page') ||
        aria.includes('次のページ')
      );
    });
  }

  async function processOneDraft(row) {
    checkStop();
    clickRow(row);

    await waitFor(() => document.querySelector('ytcp-uploads-dialog'), { timeout: 8000 });
    await delay(800);

    for (let i = 0; i < 3; i++) {
      checkStop();
      const nextBtn = await waitFor(
        () => {
          const b = document.querySelector('#next-button');
          return b && b.getAttribute('aria-disabled') !== 'true' ? b : null;
        },
        { timeout: 8000 }
      );
      nextBtn.click();
      console.log('  次へ クリック', i + 1);
      await delay(700);
    }

    checkStop();
    const saveBtn = await waitFor(() => document.querySelector('#done-button'), { timeout: 8000 });
    saveBtn.click();
    console.log('  保存 クリック');

    const closeBtn = await waitFor(
      () => {
        const candidates = [...document.querySelectorAll('button, ytcp-button')].filter(
          (b) => b.textContent.trim() === '閉じる' && isVisible(b)
        );
        return candidates.length ? candidates[candidates.length - 1] : null;
      },
      { timeout: 8000 }
    );
    closeBtn.click();
    console.log('  閉じる クリック → この1本 完了!');

    // ダイアログが消えるのを一応待つ(見つからなくてもエラーにはしない)
    await waitFor(() => !document.querySelector('ytcp-uploads-dialog'), { timeout: 6000 }).catch(() => {});
  }

  function report(msg) {
    try {
      chrome.runtime.sendMessage(msg);
    } catch (e) {
      // ポップアップが閉じてるだけなら無視してOK
    }
  }

  function saveState(patch) {
    chrome.storage.local.set(patch);
  }

  // ① 今見えてるページのドラフトを、無くなるまで処理し続ける
  async function processCurrentPage(count) {
    while (true) {
      checkStop();
      const rows = findDraftRows();
      if (rows.length === 0) {
        return count; // このページ分は打ち止め
      }
      console.log('このページの残り', rows.length, '本 → 1本処理開始');

      let succeeded = false;
      let lastError = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await processOneDraft(rows[0]);
          succeeded = true;
          break;
        } catch (e) {
          lastError = e;
          if (e && e.message === '__stopped_by_user__') throw e;
          console.warn('  ⚠️ 失敗(試行', attempt, '/3):', e.message || e, '→ 少し待ってリトライ');
          tryRecoverError();
          await delay(3000);
        }
      }

      if (!succeeded) {
        throw lastError;
      }

      count++;
      console.log('===', count, '本目 完了 ===');
      saveState({ status: 'running', count, phase: 'processing' });
      report({ type: 'progress', count });
      await delay(2500);
    }
  }

  // ②③ このページにドラフトが無くなった後の処理。まずページ更新で再確認、それでもダメなら次ページへ
  async function afterPageEmpty(count) {
    checkStop();
    console.log('このページにドラフトが見当たらない → ページを更新して確認する');
    saveState({ status: 'running', count, phase: 'awaitingReloadCheck' });
    await delay(500);
    location.reload();
    // reload後は新しいスクリプト実行に引き継がれるので、ここで終了
    await new Promise(() => {}); // reloadが効くまでの間、何もしない
  }

  // ③ 更新後もドラフトが無かった場合、次のページへ
  async function goToNextPage() {
    const nextBtn = findNextPageButton();
    if (!nextBtn) {
      return false;
    }
    console.log('  → 次のページへ移動する');
    nextBtn.click();
    await delay(2500);
    return true;
  }

  async function mainLoop({ resumeFromReloadCheck }) {
    let count = (await chrome.storage.local.get('count')).count || 0;

    if (resumeFromReloadCheck) {
      checkStop();
      const rows = findDraftRows();
      if (rows.length === 0) {
        console.log('更新してもドラフトが無かった → 次のページへ');
        const moved = await goToNextPage();
        if (!moved) {
          console.log('🎉 次のページも無い。これで全部終わり!合計', count, '本処理した!');
          saveState({ status: 'done', count, running: false });
          report({ type: 'done', count });
          return;
        }
      } else {
        console.log('更新したらドラフトが見つかった → 処理を再開');
      }
    }

    while (true) {
      count = await processCurrentPage(count);
      await afterPageEmpty(count); // この中でreloadして処理が止まる
    }
  }

  async function start() {
    window.__ytDraftBulkStop = false;
    console.log('▶ ドラフト一括公開設定 起動');
    try {
      await mainLoop({ resumeFromReloadCheck: false });
    } catch (e) {
      await handleTopLevelError(e);
    }
  }

  async function resumeAfterReload() {
    window.__ytDraftBulkStop = false;
    console.log('▶ ページ更新後、処理を再開');
    try {
      await mainLoop({ resumeFromReloadCheck: true });
    } catch (e) {
      await handleTopLevelError(e);
    }
  }

  async function handleTopLevelError(e) {
    const count = (await chrome.storage.local.get('count')).count || 0;
    if (e && e.message === '__stopped_by_user__') {
      console.log('🛑 停止ボタンが押されたので終了。ここまでで', count, '本処理した');
      saveState({ status: 'stopped', count, running: false });
      report({ type: 'stopped', count });
    } else {
      console.error('🛑 エラーで停止:', e);
      saveState({ status: 'error', count, running: false, error: String(e) });
      report({ type: 'error', count });
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'start') {
      chrome.storage.local.set({ running: true, count: 0, status: 'running', phase: 'processing' });
      start();
    } else if (msg.type === 'stop') {
      window.__ytDraftBulkStop = true;
      chrome.storage.local.set({ running: false });
    }
  });

  // ページ読み込み時に「実行中だったか」を確認して、必要なら自動で再開する
  chrome.storage.local.get(['running', 'phase'], (data) => {
    if (data.running) {
      if (data.phase === 'awaitingReloadCheck') {
        resumeAfterReload();
      } else {
        start();
      }
    }
  });
})();
