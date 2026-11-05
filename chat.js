'use strict';

/*
 * FieldBridge チャット画面（計画 第2.2版 第8章）
 * 外部ライブラリなし。fetch / IndexedDB / dialog のみ使用。
 *
 * 仮の応答 → 本物の API への切り替え：
 *   下の CONFIG.MOCK を false にする（または URL に ?mock=0 を付ける）。
 */
(() => {
  // ------------------------------------------------------------------
  // 設定
  // ------------------------------------------------------------------
  const CONFIG = {
    MOCK: true,                 // true: 仮の応答 / false: 窓口 URL へ POST
    MAX_Q: 200,                 // 質問の最大文字数（第6.3）
    HISTORY_TURNS: 3,           // 送る履歴は直近3往復まで（第6.2）
    TIMEOUT_MS: 30000,          // 30秒で打ち切り（第8.3）
    WARMUP_RETRIES: 3,          // ウォームアップの再試行回数（第6.8）
    WARMUP_RETRY_MS: 4000,      // 再試行の間隔
    DB_NAME: 'tour-guide',      // 見学ガイドと共通（第8.1）
    STORE: 'kv',
    KEY: 'qa'
  };

  const params = new URLSearchParams(location.search);
  const MOCK = params.has('mock') ? params.get('mock') !== '0' : CONFIG.MOCK;

  const MSG = {
    unavailable: 'いま質問を受け付けられません。',
    auth: '接続が許可されていません。設定の窓口 URL とトークンを確認してください。',
    rate: '質問回数の上限に達したか、混み合っています。しばらくしてからもう一度お試しください。',
    noConfig: '接続の設定がありません。右上の「設定」から窓口 URL とトークンを入れてください。',
    photoExpired: '写真の表示期限が切れました。もう一度質問してください。',
    noRecord: '資料に記録がありません。'
  };

  // ------------------------------------------------------------------
  // 要素
  // ------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const logEl = $('log');
  const formEl = $('form');
  const inputEl = $('input');
  const sendBtn = $('sendBtn');
  const resetBtn = $('resetBtn');
  const settingsBtn = $('settingsBtn');
  const statusEl = $('status');
  const mockBadge = $('mockBadge');
  const offlineBanner = $('offlineBanner');
  const settingsDlg = $('settingsDlg');
  const settingsInfo = $('settingsInfo');
  const endpointInput = $('endpointInput');
  const tokenInput = $('tokenInput');
  const labelInput = $('labelInput');
  const settingsMsg = $('settingsMsg');
  const saveBtn = $('saveBtn');
  const deleteBtn = $('deleteBtn');
  const closeSettingsBtn = $('closeSettingsBtn');
  const photoDlg = $('photoDlg');
  const photoLarge = $('photoLarge');
  const photoCaption = $('photoCaption');
  const closePhotoBtn = $('closePhotoBtn');

  // ------------------------------------------------------------------
  // 状態（会話の履歴は端末に保存しない）
  // ------------------------------------------------------------------
  let history = [];        // { role: 'user'|'assistant', content }
  let busy = false;
  let qa = null;           // { endpoint, token, label, ... }
  let memoryOnly = null;   // IndexedDB が使えないときの退避（メモリのみ）
  let warmupRun = 0;       // 古いウォームアップの結果を捨てるための番号

  // ------------------------------------------------------------------
  // 表示用の部品
  // ------------------------------------------------------------------
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 先にエスケープしてから、太字だけ変換する
  function inline(s) {
    return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  }

  function isTableRow(line) {
    return /^\s*\|.*\|\s*$/.test(line);
  }

  function isSepRow(line) {
    return isTableRow(line) && /-/.test(line) && /^[\s|:\-]+$/.test(line);
  }

  function splitCells(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  }

  const RE_UL = /^\s*[-*・]\s+/;
  const RE_OL = /^\s*\d+[.)．]\s+/;
  const RE_HEAD = /^\s*#{1,6}\s+/;

  // 回答の文字列 → 安全な HTML（表・箇条書き・太字・見出しのみ）
  function renderRich(text) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      if (line.trim() === '') { i += 1; continue; }

      // 表
      if (isTableRow(line) && i + 1 < lines.length && isSepRow(lines[i + 1])) {
        const head = splitCells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && isTableRow(lines[i]) && !isSepRow(lines[i])) {
          rows.push(splitCells(lines[i]));
          i += 1;
        }
        let h = '<div class="table-wrap"><table><thead><tr>';
        head.forEach((c) => { h += '<th>' + inline(c) + '</th>'; });
        h += '</tr></thead><tbody>';
        rows.forEach((r) => {
          h += '<tr>';
          r.forEach((c) => { h += '<td>' + inline(c) + '</td>'; });
          h += '</tr>';
        });
        h += '</tbody></table></div>';
        out.push(h);
        continue;
      }

      // 箇条書き
      if (RE_UL.test(line)) {
        let h = '<ul>';
        while (i < lines.length && RE_UL.test(lines[i])) {
          h += '<li>' + inline(lines[i].replace(RE_UL, '')) + '</li>';
          i += 1;
        }
        out.push(h + '</ul>');
        continue;
      }

      // 番号つき
      if (RE_OL.test(line)) {
        let h = '<ol>';
        while (i < lines.length && RE_OL.test(lines[i])) {
          h += '<li>' + inline(lines[i].replace(RE_OL, '')) + '</li>';
          i += 1;
        }
        out.push(h + '</ol>');
        continue;
      }

      // 見出し（太字の段落として表示）
      if (RE_HEAD.test(line)) {
        out.push('<p><strong>' + inline(line.replace(RE_HEAD, '')) + '</strong></p>');
        i += 1;
        continue;
      }

      // 段落（空行・表・箇条書き・見出しの手前まで）
      const para = [line];
      i += 1;
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !RE_UL.test(lines[i]) &&
        !RE_OL.test(lines[i]) &&
        !RE_HEAD.test(lines[i]) &&
        !(isTableRow(lines[i]) && i + 1 < lines.length && isSepRow(lines[i + 1]))
      ) {
        para.push(lines[i]);
        i += 1;
      }
      out.push('<p>' + para.map(inline).join('<br>') + '</p>');
    }
    return out.join('');
  }

  function scrollToEnd() {
    logEl.scrollTop = logEl.scrollHeight;
  }

  function clearEmptyNote() {
    const n = logEl.querySelector('.empty');
    if (n) n.remove();
  }

  function showEmptyNote() {
    logEl.textContent = '';
    logEl.appendChild(el('p', 'empty', '工場の資料をもとに質問できます。質問を入力して「送信」を押してください。'));
  }

  function addUser(text) {
    clearEmptyNote();
    logEl.appendChild(el('div', 'msg msg-user', text));
    scrollToEnd();
  }

  function addPending() {
    clearEmptyNote();
    const n = el('div', 'msg msg-bot msg-pending', '回答を作成しています…');
    logEl.appendChild(n);
    scrollToEnd();
    return n;
  }

  function addError(text) {
    clearEmptyNote();
    logEl.appendChild(el('div', 'msg msg-error', text));
    scrollToEnd();
  }

  function safePhotoUrl(u) {
    return typeof u === 'string' && /^(https:\/\/|data:image\/)/.test(u);
  }

  function buildPhoto(p) {
    const fig = el('figure', 'photo');
    const title = p && p.title ? String(p.title) : '写真';
    const meta = [p && p.era, p && p.source].filter(Boolean).join(' ／ ');

    const cap = el('figcaption');
    cap.appendChild(document.createTextNode(title));
    if (meta) cap.appendChild(el('span', 'photo-meta', meta));

    if (!p || !safePhotoUrl(p.url)) {
      fig.appendChild(el('div', 'photo-expired', MSG.photoExpired));
      fig.appendChild(cap);
      return fig;
    }

    const btn = el('button', 'photo-open');
    btn.type = 'button';
    btn.setAttribute('aria-label', title + ' を拡大');
    const img = document.createElement('img');
    img.alt = title;
    img.loading = 'lazy';
    img.src = p.url;
    img.addEventListener('error', () => {
      // 期限切れなどで読めない（URL・写真は端末に保存しない）
      btn.replaceWith(el('div', 'photo-expired', MSG.photoExpired));
    });
    btn.appendChild(img);
    btn.addEventListener('click', () => openPhoto(p.url, title, meta));
    fig.appendChild(btn);
    fig.appendChild(cap);
    return fig;
  }

  function openPhoto(url, title, meta) {
    photoLarge.alt = title;
    photoLarge.src = url;
    photoCaption.textContent = meta ? title + '（' + meta + '）' : title;
    if (typeof photoDlg.showModal === 'function') photoDlg.showModal();
  }

  function addBot(res) {
    clearEmptyNote();
    const wrap = el('div', 'msg msg-bot');
    const ans = el('div', 'answer');
    ans.innerHTML = renderRich(res.answer);
    wrap.appendChild(ans);

    // 出典は資料名のみ（第6.2）
    const titles = [];
    (Array.isArray(res.sources) ? res.sources : []).forEach((s) => {
      const t = s && s.title ? String(s.title) : '';
      if (t && titles.indexOf(t) === -1) titles.push(t);
    });
    if (res.status === 'ok' && titles.length) {
      wrap.appendChild(el('p', 'sources', '出典：' + titles.join('、')));
    }

    // no_answer のときは写真を出さない（第6.6）
    const photos = Array.isArray(res.photos) ? res.photos : [];
    if (res.status === 'ok' && photos.length) {
      const grid = el('div', 'photos');
      photos.forEach((p) => grid.appendChild(buildPhoto(p)));
      wrap.appendChild(grid);
    }

    logEl.appendChild(wrap);
    scrollToEnd();
  }

  // ------------------------------------------------------------------
  // 状態表示・ボタン
  // ------------------------------------------------------------------
  function setStatus(kind, text) {
    statusEl.className = 'status status-' + kind;
    statusEl.textContent = text;
  }

  function isOffline() {
    return navigator.onLine === false;
  }

  function updateControls() {
    const offline = isOffline();
    offlineBanner.hidden = !offline;
    sendBtn.disabled = busy || offline || inputEl.value.trim() === '';
    resetBtn.disabled = busy;
  }

  // ------------------------------------------------------------------
  // 保存（IndexedDB：見学ガイドと同じ tour-guide / kv / qa）
  // ------------------------------------------------------------------
  function openDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('indexedDB unavailable')); return; }
      const r = indexedDB.open(CONFIG.DB_NAME);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(CONFIG.STORE)) db.createObjectStore(CONFIG.STORE);
      };
      r.onsuccess = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(CONFIG.STORE)) {
          db.close();
          reject(new Error('store missing'));
          return;
        }
        resolve(db);
      };
      r.onerror = () => reject(r.error);
    });
  }

  function kvRequest(mode, fn) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(CONFIG.STORE, mode);
      const req = fn(tx.objectStore(CONFIG.STORE));
      tx.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    }));
  }

  async function loadQa() {
    try {
      const v = await kvRequest('readonly', (s) => s.get(CONFIG.KEY));
      qa = v && typeof v === 'object' ? v : null;
    } catch (e) {
      qa = memoryOnly;
    }
    return qa;
  }

  async function saveQa(next) {
    // 見学ガイド側の項目を消さないよう、既存の値に重ねて保存する
    const merged = Object.assign({}, qa || {}, next);
    try {
      await kvRequest('readwrite', (s) => s.put(merged, CONFIG.KEY));
      memoryOnly = null;
    } catch (e) {
      memoryOnly = merged;
    }
    qa = merged;
  }

  async function deleteQa() {
    try {
      await kvRequest('readwrite', (s) => s.delete(CONFIG.KEY));
    } catch (e) { /* 保存先がなければ何もしない */ }
    memoryOnly = null;
    qa = null;
  }

  // ------------------------------------------------------------------
  // 通信
  // ------------------------------------------------------------------
  class ApiError extends Error {
    constructor(kind) {
      super(kind);
      this.kind = kind; // config / auth / rate / server / timeout / network
    }
  }

  function userMessage(kind) {
    if (kind === 'config') return MSG.noConfig;
    if (kind === 'auth') return MSG.auth;
    if (kind === 'rate') return MSG.rate;
    return MSG.unavailable;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // 仮の応答：タイムアウトは AbortSignal に反応して終わる
  function mockWait(ms, signal) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new ApiError('timeout'));
      });
    });
  }

  function placeholderSvg(label, color) {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420">' +
      '<rect width="100%" height="100%" fill="' + color + '"/>' +
      '<text x="50%" y="50%" font-size="34" text-anchor="middle" fill="#fff" ' +
      'font-family="sans-serif">' + label + '</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  async function mockChat(q, hist, signal) {
    if (/timeout|時間切れ/i.test(q)) { await mockWait(CONFIG.TIMEOUT_MS + 5000, signal); }
    await mockWait(700, signal);
    if (/401/.test(q)) throw new ApiError('auth');
    if (/429/.test(q)) throw new ApiError('rate');
    if (/500|5xx/.test(q)) throw new ApiError('server');
    if (/記録|定年|賃金/.test(q)) {
      return { status: 'no_answer', answer: MSG.noRecord, sources: [], photos: [] };
    }
    if (/写真/.test(q)) {
      return {
        status: 'ok',
        answer: '【仮の応答】写真つきの表示確認です。3枚目は期限切れの表示を確認するための例です。',
        sources: [{ title: '（仮）資料A', rank: 'A' }],
        photos: [
          { id: 'MOCK-1', title: '（仮）写真1', era: '年代の例', source: '出典の例 p.1', url: placeholderSvg('PHOTO 1', '#3b6ea5') },
          { id: 'MOCK-2', title: '（仮）写真2', era: '年代の例', source: '出典の例 p.2', url: placeholderSvg('PHOTO 2', '#5a8f5a') },
          { id: 'MOCK-3', title: '（仮）期限切れの写真', era: '年代の例', source: '出典の例 p.3', url: 'https://expired.invalid/photo.jpg' }
        ]
      };
    }
    if (/表|比較/.test(q)) {
      return {
        status: 'ok',
        answer: '【仮の応答】表の表示確認です。\n\n| 項目 | 値 | 備考 |\n|---|---|---|\n| 例A | 10 | **仮** の値 |\n| 例B | 20 | 仮の値 |\n\n- 箇条書きの例1\n- 箇条書きの例2',
        sources: [{ title: '（仮）資料B', rank: 'B' }, { title: '（仮）資料C', rank: 'C' }],
        photos: []
      };
    }
    return {
      status: 'ok',
      answer: '【仮の応答】これは画面確認用の応答です。\n受け取った履歴：' + hist.length + ' 件（直近 ' + CONFIG.HISTORY_TURNS + ' 往復まで）。\n\n「写真」「表」「記録」「401」「429」「500」「timeout」を含めて送ると、各パターンを確認できます。',
      sources: [{ title: '（仮）資料A', rank: 'A' }],
      photos: []
    };
  }

  async function realFetch(path, body, signal) {
    if (!qa || !qa.endpoint || !qa.token) throw new ApiError('config');
    const base = String(qa.endpoint).replace(/\/+$/, '');
    let resp;
    try {
      resp = await fetch(base + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + qa.token
        },
        body: JSON.stringify(body),
        signal: signal
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw new ApiError('timeout');
      throw new ApiError('network');
    }
    if (resp.status === 401 || resp.status === 403) throw new ApiError('auth');
    if (resp.status === 429) throw new ApiError('rate');
    if (!resp.ok) throw new ApiError('server');
    try {
      return await resp.json();
    } catch (e) {
      throw new ApiError('server');
    }
  }

  // タイムアウトつきで呼ぶ
  async function withTimeout(fn) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CONFIG.TIMEOUT_MS);
    try {
      return await fn(ctrl.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  async function ask(q, hist) {
    const res = await withTimeout((signal) =>
      MOCK ? mockChat(q, hist, signal) : realFetch('/chat', { q: q, history: hist }, signal)
    );
    if (!res || (res.status !== 'ok' && res.status !== 'no_answer')) throw new ApiError('server');
    if (res.status === 'ok' && (typeof res.answer !== 'string' || res.answer.trim() === '')) {
      throw new ApiError('server');
    }
    if (res.status === 'no_answer' && (typeof res.answer !== 'string' || res.answer.trim() === '')) {
      res.answer = MSG.noRecord;
    }
    return res;
  }

  // ------------------------------------------------------------------
  // ウォームアップ（画面を開いたとき1回。回数の上限には数えない）
  // ------------------------------------------------------------------
  async function warmup() {
    warmupRun += 1;
    const run = warmupRun;
    setStatus('wait', '準備中');

    if (MOCK) {
      await sleep(1200);
      if (run === warmupRun) setStatus('ready', '準備できました');
      return;
    }
    if (!qa || !qa.endpoint || !qa.token) {
      setStatus('error', '未設定');
      return;
    }

    for (let attempt = 0; attempt <= CONFIG.WARMUP_RETRIES; attempt += 1) {
      try {
        await withTimeout((signal) => realFetch('/warmup', {}, signal));
        if (run === warmupRun) setStatus('ready', '準備できました');
        return;
      } catch (e) {
        if (run !== warmupRun) return;
        const kind = e && e.kind;
        if (kind === 'rate') { setStatus('ready', '準備できました'); return; } // 直近に起こし済み
        if (kind === 'auth') { setStatus('error', '接続を確認してください'); return; }
        if (kind === 'config') { setStatus('error', '未設定'); return; }
        if (attempt === CONFIG.WARMUP_RETRIES) {
          setStatus('error', '準備できませんでした（質問は送れます）');
          return;
        }
        await sleep(CONFIG.WARMUP_RETRY_MS);
        if (run !== warmupRun) return;
      }
    }
  }

  // ------------------------------------------------------------------
  // 送信
  // ------------------------------------------------------------------
  async function send() {
    const q = inputEl.value.trim();
    if (!q || busy || isOffline()) return;
    if (q.length > CONFIG.MAX_Q) {
      addError('質問は ' + CONFIG.MAX_Q + ' 字までです。');
      return;
    }
    if (!MOCK && (!qa || !qa.endpoint || !qa.token)) {
      addError(MSG.noConfig);
      openSettings();
      return;
    }

    const sentHistory = history.slice(-CONFIG.HISTORY_TURNS * 2);
    addUser(q);
    inputEl.value = '';
    busy = true;
    updateControls();
    const pending = addPending();

    try {
      const res = await ask(q, sentHistory);
      pending.remove();
      addBot(res);
      history.push({ role: 'user', content: q });
      history.push({ role: 'assistant', content: res.answer });
      history = history.slice(-CONFIG.HISTORY_TURNS * 2);
    } catch (e) {
      pending.remove();
      addError(userMessage(e && e.kind));
      if (inputEl.value === '') inputEl.value = q; // 送れなかった質問を戻す
    } finally {
      busy = false;
      updateControls();
    }
  }

  function resetConversation() {
    history = [];
    showEmptyNote();
    inputEl.value = '';
    updateControls();
  }

  // ------------------------------------------------------------------
  // 設定画面
  // ------------------------------------------------------------------
  function describeConnection() {
    if (MOCK) return '現在は仮の応答で動いています（実際の窓口には送信しません）。';
    if (!qa || !qa.token) return '接続は未設定です。';
    const tail = String(qa.token).slice(-4);
    const label = qa.label ? qa.label : '（ラベルなし）';
    return '現在の接続：' + label + ' ／ トークン末尾 ' + tail;
  }

  function openSettings() {
    settingsInfo.textContent = describeConnection();
    endpointInput.value = qa && qa.endpoint ? qa.endpoint : '';
    tokenInput.value = '';
    tokenInput.placeholder = qa && qa.token ? '変更するときだけ入力' : '';
    labelInput.value = qa && qa.label ? qa.label : '';
    settingsMsg.textContent = '';
    if (typeof settingsDlg.showModal === 'function') settingsDlg.showModal();
  }

  async function onSave() {
    const endpoint = endpointInput.value.trim();
    const token = tokenInput.value.trim() || (qa && qa.token ? qa.token : '');
    const label = labelInput.value.trim();

    if (!/^https:\/\//.test(endpoint)) {
      settingsMsg.textContent = '窓口 URL は https:// から始まる形で入力してください。';
      return;
    }
    if (!token) {
      settingsMsg.textContent = 'トークンを入力してください。';
      return;
    }
    await saveQa({ endpoint: endpoint, token: token, label: label });
    settingsMsg.textContent = memoryOnly
      ? 'この端末に保存できなかったため、画面を閉じるまでの一時的な保存です。'
      : '保存しました。';
    settingsInfo.textContent = describeConnection();
    tokenInput.value = '';
    warmup();
  }

  async function onDelete() {
    if (!window.confirm('接続情報を削除します。見学ガイド側の接続も消えます。よろしいですか？')) return;
    await deleteQa();
    endpointInput.value = '';
    tokenInput.value = '';
    labelInput.value = '';
    settingsInfo.textContent = describeConnection();
    settingsMsg.textContent = '削除しました。';
    warmup();
  }

  // ------------------------------------------------------------------
  // 起動
  // ------------------------------------------------------------------
  formEl.addEventListener('submit', (ev) => {
    ev.preventDefault();
    send();
  });
  inputEl.addEventListener('input', updateControls);
  resetBtn.addEventListener('click', resetConversation);
  settingsBtn.addEventListener('click', openSettings);
  saveBtn.addEventListener('click', onSave);
  deleteBtn.addEventListener('click', onDelete);
  closeSettingsBtn.addEventListener('click', () => settingsDlg.close());
  closePhotoBtn.addEventListener('click', () => photoDlg.close());
  photoDlg.addEventListener('close', () => { photoLarge.removeAttribute('src'); });
  window.addEventListener('online', updateControls);
  window.addEventListener('offline', updateControls);

  (async () => {
    mockBadge.hidden = !MOCK;
    showEmptyNote();
    updateControls();
    await loadQa();
    warmup();
  })();
})();
