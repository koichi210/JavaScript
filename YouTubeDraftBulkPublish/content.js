(function () {
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

  function getAllRows() {
    return [...document.querySelectorAll('ytcp-video-row')];
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

  // 今見えてる行を全部処理し終わったとき、次ページ送り or スクロール読み込みを試す
  async function tryLoadMore() {
    const nextPageBtn = findNextPageButton();
    if (nextPageBtn) {
      console.log('  → 次のページへ移動を試みる');
      nextPageBtn.click();
      await delay(2000);
      return true;
    }

    const before = getAllRows().length;
    [document.scrollingElement, document.querySelector('ytcp-video-list'), document.querySelector('#video-list')]
      .filter(Boolean)
      .forEach((el) => {
        el.scrollTop = el.scrollHeight;
      });
    window.scrollTo(0, document.body.scrollHeight);
    await delay(1800);
    const after = getAllRows().length;
    if (after > before) {
      console.log('  → スクロールで', after - before, '件 追加読み込みされた');
      return true;
    }

    return false;
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

  async function autoPublishAllDrafts() {
    window.__ytDraftBulkStop = false;
    let count = 0;
    let consecutiveLoadFails = 0;

    chrome.storage.local.set({ status: 'running', count });
    report({ type: 'progress', count });

    while (true) {
      if (window.__ytDraftBulkStop) {
        console.log('🛑 停止ボタンが押されたので終了。ここまでで', count, '本処理した');
        chrome.storage.local.set({ status: 'stopped', count });
        report({ type: 'stopped', count });
        break;
      }
      const rows = findDraftRows();
      if (rows.length === 0) {
        console.log('このページにはもうドラフトがない → 追加読み込みを試す');
        const loaded = await tryLoadMore();
        if (loaded) {
          consecutiveLoadFails = 0;
          await delay(1000);
          continue;
        }
        consecutiveLoadFails++;
        if (consecutiveLoadFails >= 3) {
          console.log('🎉 これ以上読み込めなかったので終了。合計', count, '本処理した!');
          chrome.storage.local.set({ status: 'done', count });
          report({ type: 'done', count });
          break;
        }
        console.log('  読み込み失敗', consecutiveLoadFails, '回目、もう少し待って再挑戦');
        await delay(1500);
        continue;
      }
      consecutiveLoadFails = 0;
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
          if (e && e.message === '__stopped_by_user__') break;
          console.warn('  ⚠️ 失敗(試行', attempt, '/3):', e.message || e, '→ 少し待ってリトライ');
          tryRecoverError();
          await delay(3000);
        }
      }

      if (succeeded) {
        count++;
        console.log('===', count, '本目 完了 ===');
        chrome.storage.local.set({ status: 'running', count });
        report({ type: 'progress', count });
      } else if (lastError && lastError.message === '__stopped_by_user__') {
        console.log('🛑 停止ボタンが押されたので終了。ここまでで', count, '本処理した');
        chrome.storage.local.set({ status: 'stopped', count });
        report({ type: 'stopped', count });
        break;
      } else {
        console.error('🛑 3回試して失敗したので停止:', lastError);
        chrome.storage.local.set({ status: 'error', count, error: String(lastError) });
        report({ type: 'error', count });
        break;
      }

      await delay(2500);
    }
  }

  console.log('▶ ドラフト一括公開設定スクリプト起動');
  autoPublishAllDrafts();
})();
