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

  // ===== タイトル一括変更パネル =====

  function getVisibleRows() {
    return [...document.querySelectorAll('ytcp-video-row')].filter(isVisible);
  }

  function getRowThumbnail(row) {
    const img = row.querySelector('img');
    return img ? img.src : '';
  }

  function getRowTitle(row) {
    const titleEl = row.querySelector('#video-title');
    return titleEl ? titleEl.textContent.trim() : '';
  }

  function getRowVideoId(row) {
    const a = row.querySelector('#video-title') || row.querySelector('a[href]');
    if (!a) return null;
    const m = (a.getAttribute('href') || '').match(/\/video\/([^/]+)\//);
    return m ? m[1] : null;
  }

  function findRowByVideoId(videoId) {
    return [...document.querySelectorAll('ytcp-video-row')].find((row) => getRowVideoId(row) === videoId);
  }

  async function setTitleField(newTitle) {
    const box = await waitFor(() => document.querySelector('#title-textarea #textbox'), { timeout: 8000 });
    box.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, newTitle);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await delay(300);
  }

  async function saveTitleAndClose(videoId, originalListUrl) {
    // 公開済み動画: 上部に単独の「保存」ボタンが出る想定
    let saveBtn = [...document.querySelectorAll('button, ytcp-button')].find(
      (b) => b.textContent.trim() === '保存' && isVisible(b) && b.getAttribute('aria-disabled') !== 'true'
    );
    if (saveBtn) {
      saveBtn.click();
      console.log('  保存 クリック(公開済み動画)');
      await waitFor(() => !document.querySelector('#title-textarea'), { timeout: 8000 }).catch(() => {});
      await delay(500);
      // 公開済み動画の編集画面は保存しても一覧に自動で戻らないので、戻る
      if (!document.querySelector('ytcp-video-row')) {
        console.log('  ← 一覧画面に戻る');
        history.back();
        // この動画の行が実際に再描画されるまで、しっかり待つ(一覧の再取得に時間がかかることがある)
        const found = await waitFor(() => (videoId ? findRowByVideoId(videoId) : document.querySelector('ytcp-video-row')), {
          timeout: 12000,
          interval: 400,
        }).catch(() => null);
        if (!found) {
          console.warn('  ⚠️ 一覧に戻ったが、この動画の行が見当たらない(URL:', location.href, ')');
        }
        await delay(500);
      }
      return;
    }

    // ドラフト動画: ウィザードのXボタンで閉じる → 下書きとして自動保存される想定
    const closeBtn = [...document.querySelectorAll('ytcp-icon-button, button')].find((b) => {
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      return isVisible(b) && (aria.includes('close') || aria.includes('閉じる') || b.id === 'close-icon-button');
    });
    if (closeBtn) {
      closeBtn.click();
      console.log('  ✕ クリック(ドラフト動画、下書きとして保存想定)');
      await delay(800);
      // 確認ダイアログが出たら保存側を選ぶ
      const confirmSave = [...document.querySelectorAll('button, ytcp-button')].find(
        (b) => b.textContent.trim() === '保存' && isVisible(b)
      );
      if (confirmSave) confirmSave.click();
      await delay(800);
    } else {
      throw new Error('保存ボタンも閉じるボタンも見つからなかった');
    }
  }

  async function updateOneTitle(row, newTitle, originalListUrl) {
    checkStop();
    const videoId = getRowVideoId(row);
    clickRow(row);
    await waitFor(() => document.querySelector('#title-textarea #textbox'), { timeout: 8000 });
    await delay(500);
    await setTitleField(newTitle);
    await saveTitleAndClose(videoId, originalListUrl);
  }

  let titlePanelEl = null;

  function closeTitlePanel() {
    if (titlePanelEl) {
      if (titlePanelEl.__pollTimer) clearInterval(titlePanelEl.__pollTimer);
      titlePanelEl.remove();
      titlePanelEl = null;
    }
  }

  function openTitlePanel() {
    if (titlePanelEl) {
      closeTitlePanel();
      return;
    }

    let rows = getVisibleRows();
    let originalListUrl = location.href;
    let applying = false;

    const panel = document.createElement('div');
    panel.style.cssText = `
      position: fixed; top: 16px; right: 16px; bottom: 140px; width: 340px;
      background: #212121; color: #eee; z-index: 999999; border-radius: 10px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.5); font-family: sans-serif;
      display: flex; flex-direction: column; overflow: hidden;
      border: 1px solid #444;
    `;

    panel.innerHTML = `
      <div style="padding:12px 14px; background:#2b2b2b; display:flex; justify-content:space-between; align-items:center;">
        <strong id="ytb-title-heading">✏️ タイトル一括変更</strong>
        <span id="ytb-title-close" style="cursor:pointer; font-size:18px;">✕</span>
      </div>
      <div id="ytb-title-list" style="overflow-y:auto; padding:10px 14px; flex:1;"></div>
      <div style="padding:10px 14px; border-top:1px solid #444; background:#2b2b2b;">
        <div id="ytb-title-status" style="font-size:12px; color:#ccc; margin-bottom:8px;">変えたい行だけ書き換えてね</div>
        <button id="ytb-title-apply" style="width:100%; padding:10px; background:#9c6ade; color:#fff; border:none; border-radius:6px; font-weight:bold; cursor:pointer;">一括変更 実行</button>
      </div>
    `;

    document.body.appendChild(panel);
    titlePanelEl = panel;

    const list = panel.querySelector('#ytb-title-list');
    const heading = panel.querySelector('#ytb-title-heading');
    const statusElOuter = panel.querySelector('#ytb-title-status');

    function renderList() {
      heading.textContent = `✏️ タイトル一括変更 (${rows.length}件)`;
      list.innerHTML = '';
      rows.forEach((row) => {
        const original = getRowTitle(row);
        const thumb = getRowThumbnail(row);
        const item = document.createElement('div');
        item.style.cssText = 'display:flex; gap:8px; align-items:center; margin-bottom:10px;';
        item.innerHTML = `
          ${thumb ? `<img src="${thumb}" style="width:48px; height:27px; object-fit:cover; border-radius:4px; flex-shrink:0;">` : ''}
          <input type="text" value="${original.replace(/"/g, '&quot;')}" style="flex:1; min-width:0; padding:6px 8px; background:#1a1a1a; color:#eee; border:1px solid #555; border-radius:4px; font-size:12px;">
        `;
        const input = item.querySelector('input');
        input.dataset.original = original;
        input.dataset.videoId = getRowVideoId(row) || '';
        list.appendChild(item);
      });
    }

    renderList();
    // 「今の状態」を文字列として固定で覚えておく(rowsの要素は使い回されるので、都度読み直すと比較にならない)
    let lastKnownIds = rows.map(getRowVideoId).join(',');

    // ブラウザ側で次のページ/前のページに移動したら、パネルの中身を追従させる
    // (行のDOMは使い回されて中身だけ書き換わるタイプなので、MutationObserverでなく定期チェックにする)
    const pollTimer = setInterval(() => {
      if (applying) return; // 実行中は横から書き換えない
      const freshRows = getVisibleRows();
      if (freshRows.length === 0) return;
      const freshIds = freshRows.map(getRowVideoId).join(',');
      if (freshIds !== lastKnownIds) {
        console.log('📄 一覧が変わったのを検知 → タイトルパネルを更新');
        rows = freshRows;
        lastKnownIds = freshIds;
        originalListUrl = location.href;
        renderList();
      }
    }, 1000);
    titlePanelEl.__pollTimer = pollTimer;

    panel.querySelector('#ytb-title-close').addEventListener('click', closeTitlePanel);

    panel.querySelector('#ytb-title-apply').addEventListener('click', async () => {
      const statusEl = statusElOuter;
      const applyBtn = panel.querySelector('#ytb-title-apply');
      const inputs = [...list.querySelectorAll('input')].filter(
        (inp) => inp.value.trim() !== inp.dataset.original.trim() && inp.value.trim() !== ''
      );

      if (inputs.length === 0) {
        statusEl.textContent = '変更されてる行がないよ';
        return;
      }

      applyBtn.disabled = true;
      applyBtn.textContent = '実行中...';
      window.__ytDraftBulkStop = false;
      applying = true;

      let done = 0;
      let failed = 0;
      for (const input of inputs) {
        const videoId = input.dataset.videoId;
        const newTitle = input.value.trim();
        statusEl.textContent = `処理中... (${done + failed + 1}/${inputs.length})`;
        try {
          const row = videoId ? findRowByVideoId(videoId) : null;
          if (!row) {
            throw new Error('この動画が今の画面上で見つからなかった(一覧が作り直された?)');
          }
          await updateOneTitle(row, newTitle, originalListUrl);
          done++;
          input.style.borderColor = '#3fb950';
          console.log('✅ タイトル変更完了:', newTitle);
        } catch (e) {
          failed++;
          input.style.borderColor = '#e05252';
          console.error('🛑 タイトル変更失敗:', newTitle, e);
        }
        await delay(2000);
      }

      applying = false;
      applyBtn.disabled = false;
      applyBtn.textContent = '一括変更 実行';
      statusEl.textContent = `完了: 成功${done}件 / 失敗${failed}件`;

      // 実行が終わったタイミングで、念のため最新の一覧に合わせておく
      const freshRows = getVisibleRows();
      if (freshRows.length > 0) {
        rows = freshRows;
        lastKnownIds = freshRows.map(getRowVideoId).join(',');
        originalListUrl = location.href;
        renderList();
      }
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'start') {
      chrome.storage.local.set({ running: true, count: 0, status: 'running', phase: 'processing' });
      start();
    } else if (msg.type === 'stop') {
      window.__ytDraftBulkStop = true;
      chrome.storage.local.set({ running: false });
    } else if (msg.type === 'toggleTitlePanel') {
      openTitlePanel();
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
