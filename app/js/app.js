import * as db from './db.js';
import { DEFAULT_SETTINGS, today, addDays, isDue, newCardFields, preview, applyGrade, statusText, parseSchedule } from './srs.js';
import { $, esc, richText, snippet, renderMath, compressImage, blobUrl, revokeUrls, promptText, confirmDlg, actionSheet, toast, showImage, download } from './util.js';
import { notifSupported, requestPermission, showReminder, scheduleInApp, registerPeriodicSync, buildICS } from './notify.js';
import { exportData, importData } from './backup.js';

const MAX_LEN = 2000;
const SUBJECTS = ['経済学・経済政策', '財務・会計', '企業経営理論', '運営管理', '経営法務', '経営情報システム', '中小企業経営・中小企業政策'];
const GRADES = [
  { g: 'again', label: 'もう一度', cls: 'g-again' },
  { g: 'hard', label: '難しい', cls: 'g-hard' },
  { g: 'good', label: '正解', cls: 'g-good' },
  { g: 'easy', label: '簡単', cls: 'g-easy' },
];

let settings = { ...DEFAULT_SETTINGS };
const view = $('#view');
let keyHandler = null;

// ---------------------------------------------------------------- helpers
async function loadSettings() {
  settings = { ...DEFAULT_SETTINGS, ...(await db.kvGet('settings', {})) };
}
async function saveSettings() {
  await db.kvSet('settings', settings);
}

function setHeader(title, back, right = '') {
  $('#title').textContent = title;
  const b = $('#back');
  b.hidden = !back;
  b.onclick = () => { location.hash = back; };
  $('#hdr-right').innerHTML = right;
  document.title = title === '暗記ノート' ? '暗記ノート' : `${title} - 暗記ノート`;
}

const byOrder = (a, b) => (a.order || 0) - (b.order || 0) || (a.createdAt || 0) - (b.createdAt || 0);
const byCreated = (a, b) => (a.createdAt || 0) - (b.createdAt || 0);

async function subjects() {
  return (await db.getAll('folders', 'parentId', '')).filter((f) => f.kind === 'subject').sort(byOrder);
}
async function unitsOf(subjectId) {
  return (await db.getAll('folders', 'parentId', subjectId)).sort(byOrder);
}

function counts(cards) {
  const t = today();
  let due = 0, nw = 0, done = 0;
  for (const c of cards) {
    if (c.state === 'new') nw++;
    else if (c.state === 'mastered') done++;
    else if (c.due <= t) due++;
  }
  return { total: cards.length, due, nw, done };
}

async function newUsedToday() {
  const n = await db.kvGet('newToday', { date: '', count: 0 });
  return n.date === today() ? n.count : 0;
}
async function newRemaining() {
  return Math.max(0, settings.newPerDay - (await newUsedToday()));
}
async function todayCount(cards) {
  const c = counts(cards);
  return c.due + Math.min(c.nw, await newRemaining());
}

async function logReview(correct) {
  const h = await db.kvGet('history', {});
  const t = today();
  const e = h[t] || { reviewed: 0, correct: 0 };
  e.reviewed++;
  if (correct) e.correct++;
  h[t] = e;
  await db.kvSet('history', h);
}

function streak(h) {
  let d = today();
  if (!h[d]?.reviewed) d = addDays(d, -1);
  let n = 0;
  while (h[d]?.reviewed) { n++; d = addDays(d, -1); }
  return n;
}

function badgeHtml(c) {
  const parts = [];
  if (c.due) parts.push(`<span class="pill due">今日 ${c.due}</span>`);
  if (c.nw) parts.push(`<span class="pill new">未学習 ${c.nw}</span>`);
  parts.push(`<span class="muted">${c.total}枚${c.done ? ` / クリア ${c.done}` : ''}</span>`);
  return parts.join(' ');
}

async function moveOrder(folder, siblings, dir) {
  const i = siblings.findIndex((f) => f.id === folder.id);
  const j = i + dir;
  if (j < 0 || j >= siblings.length) return;
  siblings.forEach((f, k) => { f.order = k; });
  [siblings[i].order, siblings[j].order] = [siblings[j].order, siblings[i].order];
  await db.putMany('folders', siblings);
}

async function folderMenu(folder, siblings, onDeleted) {
  const isSub = folder.kind === 'subject';
  const act = await actionSheet(folder.name, [
    { label: '名前を変更', value: 'rename' },
    { label: '上へ移動', value: 'up' },
    { label: '下へ移動', value: 'down' },
    { label: '学習記録をリセット', value: 'reset' },
    { label: isSub ? 'この科目を削除' : 'この単元を削除', value: 'delete', danger: true },
  ]);
  if (act === 'rename') {
    const name = await promptText('名前を変更', folder.name);
    if (name) { folder.name = name; await db.put('folders', folder); }
  } else if (act === 'up' || act === 'down') {
    await moveOrder(folder, siblings, act === 'up' ? -1 : 1);
  } else if (act === 'reset') {
    if (await confirmDlg(`「${folder.name}」の全カードを未学習の状態に戻しますか？`, 'リセット', true)) {
      const cards = await db.getAll('cards', isSub ? 'subjectId' : 'unitId', folder.id);
      await db.putMany('cards', cards.map((c) => ({ ...c, ...newCardFields() })));
      toast('リセットしました');
    }
  } else if (act === 'delete') {
    const cards = await db.getAll('cards', isSub ? 'subjectId' : 'unitId', folder.id);
    const msg = `「${folder.name}」${isSub ? 'とその中の単元' : ''}・カード${cards.length}枚を削除します。元に戻せません。`;
    if (await confirmDlg(msg, '削除', true)) {
      await db.deleteFolder(folder);
      toast('削除しました');
      if (onDeleted) { onDeleted(); return; }
    }
  }
  route();
}

// ---------------------------------------------------------------- home
async function home() {
  setHeader('暗記ノート', null, `<button class="icon-btn" id="go-settings" aria-label="設定">⚙︎</button>`);
  $('#go-settings').onclick = () => { location.hash = '#/settings'; };
  const [subs, cards, hist] = await Promise.all([subjects(), db.getAll('cards'), db.kvGet('history', {})]);
  const total = await todayCount(cards);
  const todayLog = hist[today()] || { reviewed: 0, correct: 0 };
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const hideHint = await db.kvGet('hideInstallHint', false);

  view.innerHTML = `
    ${!standalone && !hideHint ? `
      <div class="notice">
        <b>ホーム画面に追加してください</b><br>
        iPhone：Safariの共有ボタン →「ホーム画面に追加」<br>
        Android：Chromeのメニュー →「ホーム画面に追加 / アプリをインストール」<br>
        <small>追加するとアプリとして起動でき、データも消えにくくなります。</small>
        <button class="link" id="hide-hint">閉じる</button>
      </div>` : ''}
    <section class="hero">
      <div class="hero-num">${total}<small>枚</small></div>
      <div class="hero-label">今日の学習</div>
      <button class="btn primary big" id="start-all" ${total ? '' : 'disabled'}>${total ? '今日の復習を始める' : '今日の復習は完了です 🎉'}</button>
      <div class="hero-stats">
        <span>今日解いた <b>${todayLog.reviewed}</b>枚</span>
        <span>連続 <b>${streak(hist)}</b>日</span>
        <span>全 <b>${cards.length}</b>枚</span>
      </div>
    </section>
    <div class="sec-head"><h2>科目フォルダ</h2><button class="btn small" id="add-sub">＋ 科目</button></div>
    <ul class="list" id="subs"></ul>
    ${subs.length ? '' : `
      <div class="empty">
        <p>まだ科目がありません。</p>
        <button class="btn primary" id="seed">診断士7科目をまとめて作成</button>
      </div>`}
  `;

  const ul = $('#subs');
  for (const s of subs) {
    const c = counts(cards.filter((x) => x.subjectId === s.id));
    const li = document.createElement('li');
    li.innerHTML = `
      <a href="#/s/${s.id}" class="row">
        <span class="row-icon">📁</span>
        <span class="row-main"><span class="row-title">${esc(s.name)}</span><span class="row-sub">${badgeHtml(c)}</span></span>
      </a>
      <button class="icon-btn more" aria-label="メニュー">⋯</button>`;
    li.querySelector('.more').onclick = () => folderMenu(s, subs);
    ul.appendChild(li);
  }

  $('#start-all').onclick = () => { location.hash = '#/study?scope=all&mode=due'; };
  $('#add-sub').onclick = async () => {
    const name = await promptText('科目フォルダを追加', '', '例：財務・会計');
    if (!name) return;
    await db.put('folders', { id: db.uid(), kind: 'subject', parentId: '', name, order: Date.now(), createdAt: Date.now() });
    route();
  };
  const seed = $('#seed');
  if (seed) seed.onclick = async () => {
    const now = Date.now();
    await db.putMany('folders', SUBJECTS.map((name, i) => ({ id: db.uid(), kind: 'subject', parentId: '', name, order: now + i, createdAt: now + i })));
    route();
  };
  const hh = $('#hide-hint');
  if (hh) hh.onclick = async () => { await db.kvSet('hideInstallHint', true); route(); };
}

// ---------------------------------------------------------------- subject
async function subjectView(id) {
  const s = await db.get('folders', id);
  if (!s) { location.hash = '#/'; return; }
  setHeader(s.name, '#/', `<button class="icon-btn" id="sub-menu" aria-label="メニュー">⋯</button>`);
  const [units, cards, subs] = await Promise.all([unitsOf(id), db.getAll('cards', 'subjectId', id), subjects()]);
  $('#sub-menu').onclick = () => folderMenu(s, subs, () => { location.hash = '#/'; });
  const c = counts(cards);
  const tc = await todayCount(cards);

  view.innerHTML = `
    <section class="study-box">
      <div class="study-box-info">${badgeHtml(c)}</div>
      <button class="btn primary block" id="st-due" ${tc ? '' : 'disabled'}>今日の復習（${tc}枚）</button>
      <div class="btn-row">
        <button class="btn" id="st-all" ${c.total ? '' : 'disabled'}>全カード</button>
        <button class="btn" id="st-weak" ${c.total ? '' : 'disabled'}>苦手のみ</button>
      </div>
    </section>
    <div class="sec-head"><h2>単元</h2><button class="btn small" id="add-unit">＋ 単元</button></div>
    <ul class="list" id="units"></ul>
    ${units.length ? '' : '<p class="empty">「＋ 単元」から単元を作成してください。<br>例：経営分析、CVP分析、投資の意思決定</p>'}
  `;
  const ul = $('#units');
  for (const u of units) {
    const uc = counts(cards.filter((x) => x.unitId === u.id));
    const li = document.createElement('li');
    li.innerHTML = `
      <a href="#/u/${u.id}" class="row">
        <span class="row-icon">📒</span>
        <span class="row-main"><span class="row-title">${esc(u.name)}</span><span class="row-sub">${badgeHtml(uc)}</span></span>
      </a>
      <button class="icon-btn more" aria-label="メニュー">⋯</button>`;
    li.querySelector('.more').onclick = () => folderMenu(u, units);
    ul.appendChild(li);
  }
  const go = (mode) => { location.hash = `#/study?scope=subject&id=${id}&mode=${mode}`; };
  $('#st-due').onclick = () => go('due');
  $('#st-all').onclick = () => go('all');
  $('#st-weak').onclick = () => go('weak');
  $('#add-unit').onclick = async () => {
    const name = await promptText('単元を追加', '', '例：経営分析');
    if (!name) return;
    await db.put('folders', { id: db.uid(), kind: 'unit', parentId: id, name, order: Date.now(), createdAt: Date.now() });
    route();
  };
}

// ---------------------------------------------------------------- unit
async function unitView(id) {
  const u = await db.get('folders', id);
  if (!u) { location.hash = '#/'; return; }
  setHeader(u.name, `#/s/${u.parentId}`, `<button class="icon-btn" id="unit-menu" aria-label="メニュー">⋯</button>`);
  const [cards, siblings] = await Promise.all([db.getAll('cards', 'unitId', id), unitsOf(u.parentId)]);
  cards.sort(byCreated);
  $('#unit-menu').onclick = () => folderMenu(u, siblings, () => { location.hash = `#/s/${u.parentId}`; });
  const c = counts(cards);
  const tc = await todayCount(cards);
  const q = sessionStorage.getItem('q:' + id) || '';

  view.innerHTML = `
    <section class="study-box">
      <div class="study-box-info">${badgeHtml(c)}</div>
      <button class="btn primary block" id="st-due" ${tc ? '' : 'disabled'}>今日の復習（${tc}枚）</button>
      <div class="btn-row">
        <button class="btn" id="st-all" ${c.total ? '' : 'disabled'}>全カード</button>
        <button class="btn" id="st-weak" ${c.total ? '' : 'disabled'}>苦手のみ</button>
      </div>
    </section>
    <div class="btn-row">
      <a class="btn" href="#/edit/new?u=${id}">＋ カード追加</a>
      <a class="btn" href="#/bulk/${id}">まとめて追加</a>
    </div>
    <input type="search" id="search" class="search" placeholder="カードを検索" value="${esc(q)}">
    <ul class="list cards" id="cards"></ul>
  `;
  const ul = $('#cards');
  const draw = () => {
    const term = $('#search').value.trim().toLowerCase();
    sessionStorage.setItem('q:' + id, term);
    const list = term ? cards.filter((x) => (x.q + '\n' + x.a).toLowerCase().includes(term)) : cards;
    ul.innerHTML = list.length ? list.map((x) => {
      const st = statusText(x);
      const no = cards.indexOf(x) + 1;
      return `<li><a class="row card-row" href="#/edit/${x.id}">
        <span class="no">${no}</span>
        <span class="row-main">
          <span class="row-title">${esc(snippet(x.q, 70)) || '<span class="muted">(問題文なし)</span>'}${x.qImg || x.aImg ? ' 🖼' : ''}</span>
          <span class="row-sub muted">${esc(snippet(x.a, 50))}</span>
        </span>
        <span class="st ${st.cls}">${st.text}</span>
      </a></li>`;
    }).join('') : `<li class="empty">${term ? '見つかりません' : 'カードがありません。「＋ カード追加」から作成しましょう。'}</li>`;
  };
  draw();
  $('#search').oninput = draw;
  const go = (mode) => { location.hash = `#/study?scope=unit&id=${id}&mode=${mode}`; };
  $('#st-due').onclick = () => go('due');
  $('#st-all').onclick = () => go('all');
  $('#st-weak').onclick = () => go('weak');
}

// ---------------------------------------------------------------- card editor
function imgPickerHtml(side, label) {
  return `
    <div class="img-pick" id="${side}-imgbox">
      <div class="img-prev" id="${side}-prev"></div>
      <label class="btn small">📷 ${label}<input type="file" accept="image/*" id="${side}-file" hidden></label>
      <button type="button" class="btn small ghost" id="${side}-rm" hidden>画像を削除</button>
    </div>`;
}

async function editView(id, qs) {
  const params = new URLSearchParams(qs || '');
  const isNew = id === 'new';
  let card = isNew ? null : await db.get('cards', id);
  const unitId = isNew ? params.get('u') : card?.unitId;
  const unit = await db.get('folders', unitId);
  if (!unit || (!isNew && !card)) { location.hash = '#/'; return; }
  const back = `#/u/${unit.id}`;
  setHeader(isNew ? 'カード追加' : 'カード編集', back, isNew ? '' : `<button class="icon-btn" id="card-menu" aria-label="メニュー">⋯</button>`);

  const img = { q: { id: card?.qImg || null, blob: null, removed: false }, a: { id: card?.aImg || null, blob: null, removed: false } };
  const st = card ? statusText(card) : null;

  view.innerHTML = `
    <form id="card-form" class="editor">
      <p class="muted small">単元：${esc(unit.name)}${card ? ` ／ 状態：<span class="st ${st.cls}">${st.text}</span> ／ 解答 ${card.reviews}回・正解 ${card.correct}回` : ''}</p>
      <label class="field-label">問題（表）<span class="counter" id="q-count"></span></label>
      <textarea id="q" maxlength="${MAX_LEN}" rows="6" placeholder="例：自己資本利益率（ROE）の計算式は？">${esc(card?.q || '')}</textarea>
      ${imgPickerHtml('q', '問題に画像を添付')}
      <label class="field-label">答え（裏）<span class="counter" id="a-count"></span></label>
      <textarea id="a" maxlength="${MAX_LEN}" rows="6" placeholder="例：$ROE = \\frac{当期純利益}{自己資本} \\times 100$">${esc(card?.a || '')}</textarea>
      ${imgPickerHtml('a', '答えに画像を添付')}
      <details class="help"><summary>書き方のヒント</summary>
        <p><code>**重要**</code> → <b>太字</b><br>
        <code>$ROE = \\frac{当期純利益}{自己資本}$</code> → 数式（分数）<br>
        <code>$a \\times b$</code>（かけ算）、<code>$\\div$</code>（割り算）、<code>$x^2$</code>（2乗）、<code>$\\sqrt{x}$</code>（ルート）<br>
        <code>$$ ... $$</code> で囲むと中央寄せの大きな数式になります。</p>
      </details>
      <div class="editor-btns">
        <button type="submit" class="btn primary" id="save">保存</button>
        ${isNew ? '<button type="button" class="btn" id="save-next">保存して次を作成</button>' : ''}
      </div>
    </form>`;

  const qEl = $('#q'), aEl = $('#a');
  const upd = () => {
    $('#q-count').textContent = `${qEl.value.length} / ${MAX_LEN}`;
    $('#a-count').textContent = `${aEl.value.length} / ${MAX_LEN}`;
  };
  qEl.oninput = aEl.oninput = upd;
  upd();

  for (const side of ['q', 'a']) {
    const prev = $(`#${side}-prev`), rm = $(`#${side}-rm`);
    const show = (blob) => {
      if (blob) {
        const u = blobUrl(blob);
        prev.innerHTML = `<img src="${u}" alt="">`;
        prev.querySelector('img').onclick = () => showImage(u);
        rm.hidden = false;
      } else {
        prev.innerHTML = '';
        rm.hidden = true;
      }
    };
    if (img[side].id) {
      const rec = await db.get('images', img[side].id);
      show(rec?.blob);
    }
    $(`#${side}-file`).onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        img[side].blob = await compressImage(f);
        img[side].removed = false;
        show(img[side].blob);
      } catch {
        toast('画像を読み込めませんでした');
      }
      e.target.value = '';
    };
    rm.onclick = () => { img[side].blob = null; img[side].removed = true; show(null); };
  }

  const save = async () => {
    const q = qEl.value.trim(), a = aEl.value.trim();
    if (!q && !img.q.blob && !(img.q.id && !img.q.removed)) { toast('問題を入力してください'); qEl.focus(); return false; }
    const data = card ? { ...card } : { id: db.uid(), unitId: unit.id, subjectId: unit.parentId, createdAt: Date.now(), ...newCardFields() };
    data.q = q;
    data.a = a;
    data.updatedAt = Date.now();
    for (const side of ['q', 'a']) {
      const key = side + 'Img';
      if (img[side].blob) {
        if (data[key]) await db.del('images', data[key]);
        const nid = db.uid();
        await db.put('images', { id: nid, blob: img[side].blob });
        data[key] = nid;
      } else if (img[side].removed && data[key]) {
        await db.del('images', data[key]);
        data[key] = null;
      }
    }
    await db.put('cards', data);
    requestPersist();
    return true;
  };

  $('#card-form').onsubmit = async (e) => {
    e.preventDefault();
    if (await save()) { toast('保存しました'); location.hash = back; }
  };
  const sn = $('#save-next');
  if (sn) sn.onclick = async () => {
    if (await save()) { toast('保存しました'); route(); }
  };
  const menu = $('#card-menu');
  if (menu) menu.onclick = async () => {
    const act = await actionSheet('カード', [
      { label: card.state === 'mastered' ? 'クリアを解除（明日から復習）' : 'クリア済みにする', value: 'master' },
      { label: '別の単元へ移動', value: 'move' },
      { label: '学習記録をリセット', value: 'reset' },
      { label: 'このカードを削除', value: 'delete', danger: true },
    ]);
    if (act === 'master') {
      card = card.state === 'mastered'
        ? { ...card, state: 'review', level: Math.max(1, settings.schedule.length - 1), due: addDays(today(), 1) }
        : { ...card, state: 'mastered', level: settings.schedule.length + 1, due: addDays(today(), 36500) };
      await db.put('cards', card);
      toast(card.state === 'mastered' ? 'クリアにしました' : 'クリアを解除しました');
      route();
    } else if (act === 'move') {
      const dest = await pickUnit(unit.id);
      if (!dest) return;
      await db.put('cards', { ...card, unitId: dest.id, subjectId: dest.parentId });
      toast(`「${dest.name}」へ移動しました`);
      location.hash = `#/u/${dest.id}`;
    } else if (act === 'reset') {
      await db.put('cards', { ...card, ...newCardFields() });
      toast('リセットしました');
      route();
    } else if (act === 'delete') {
      if (await confirmDlg('このカードを削除しますか？', '削除', true)) {
        await db.deleteCards([card]);
        toast('削除しました');
        location.hash = back;
      }
    }
  };
}

async function pickUnit(excludeId) {
  const subs = await subjects();
  const opts = [];
  for (const s of subs) for (const u of await unitsOf(s.id)) if (u.id !== excludeId) opts.push({ label: `${s.name} ／ ${u.name}`, value: u.id });
  if (!opts.length) { toast('移動先の単元がありません'); return null; }
  const v = await actionSheet('移動先の単元', opts);
  return v ? db.get('folders', v) : null;
}

// ---------------------------------------------------------------- bulk add
function parseDSV(text, delim) {
  const rows = [];
  if (delim === '::') {
    for (const line of text.split(/\r?\n/)) {
      const i = line.indexOf('::');
      if (i < 0) { if (line.trim()) rows.push([line, '']); continue; }
      rows.push([line.slice(0, i), line.slice(i + 2)]);
    }
    return rows;
  }
  // tab / comma separated with "quoted" fields (Excel / Google Sheets copy)
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += ch;
    } else if (ch === '"' && field === '') q = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function bulkView(unitId) {
  const unit = await db.get('folders', unitId);
  if (!unit) { location.hash = '#/'; return; }
  setHeader('まとめて追加', `#/u/${unitId}`);
  view.innerHTML = `
    <div class="editor">
      <p class="small">1行に1枚、「問題」と「答え」を区切り文字で区切って貼り付けます。<br>
      Excel・スプレッドシートで <b>A列＝問題 / B列＝答え</b> を作り、範囲をコピーしてそのまま貼り付けられます（区切り：タブ）。</p>
      <label class="field-label">区切り文字</label>
      <select id="delim">
        <option value="\t">タブ（Excel / スプレッドシートからコピー）</option>
        <option value="::">::（例：ROEの式は？::当期純利益÷自己資本）</option>
        <option value=",">カンマ（CSV）</option>
      </select>
      <label class="field-label">内容 <span class="counter" id="bulk-count">0枚</span></label>
      <textarea id="bulk" rows="12" placeholder="ROEの計算式は？&#9;当期純利益 ÷ 自己資本 × 100&#10;損益分岐点売上高は？&#9;固定費 ÷ 限界利益率"></textarea>
      <p class="muted small">文中の <code>\\n</code> は改行に変換されます。</p>
      <button class="btn primary block" id="bulk-add">追加する</button>
    </div>`;
  const parse = () => parseDSV($('#bulk').value, $('#delim').value)
    .map((r) => [String(r[0] || '').replace(/\\n/g, '\n').trim(), String(r.slice(1).join(' ') || '').replace(/\\n/g, '\n').trim()])
    .filter(([q]) => q)
    .map(([q, a]) => [q.slice(0, MAX_LEN), a.slice(0, MAX_LEN)]);
  const upd = () => { $('#bulk-count').textContent = `${parse().length}枚`; };
  $('#bulk').oninput = upd;
  $('#delim').onchange = upd;
  $('#bulk-add').onclick = async () => {
    const rows = parse();
    if (!rows.length) { toast('追加するカードがありません'); return; }
    const now = Date.now();
    await db.putMany('cards', rows.map(([q, a], i) => ({
      id: db.uid(), unitId, subjectId: unit.parentId, q, a, qImg: null, aImg: null,
      createdAt: now + i, updatedAt: now + i, ...newCardFields(),
    })));
    requestPersist();
    toast(`${rows.length}枚追加しました`);
    location.hash = `#/u/${unitId}`;
  };
}

// ---------------------------------------------------------------- study
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function studyView(qs) {
  const p = new URLSearchParams(qs);
  const scope = p.get('scope') || 'all', id = p.get('id'), mode = p.get('mode') || 'due';
  let cards, title, back;
  if (scope === 'unit') {
    const u = await db.get('folders', id);
    cards = await db.getAll('cards', 'unitId', id);
    title = u?.name || '学習'; back = `#/u/${id}`;
  } else if (scope === 'subject') {
    const s = await db.get('folders', id);
    cards = await db.getAll('cards', 'subjectId', id);
    title = s?.name || '学習'; back = `#/s/${id}`;
  } else {
    cards = await db.getAll('cards');
    title = '今日の復習'; back = '#/';
  }
  const modeLabel = { due: '今日の復習', all: '全カード', weak: '苦手のみ' }[mode];
  setHeader(`${title}（${modeLabel}）`, back);

  cards.sort(byCreated);
  let queue;
  const t = today();
  if (mode === 'all') {
    queue = settings.shuffle ? shuffle([...cards]) : [...cards];
  } else if (mode === 'weak') {
    const w = cards.filter((c) => c.lapses > 0 || c.lastGrade === 'again' || c.lastGrade === 'hard');
    queue = settings.shuffle ? shuffle(w) : w;
  } else {
    const rev = cards.filter((c) => c.state !== 'new' && isDue(c, t));
    const nw = cards.filter((c) => c.state === 'new').slice(0, await newRemaining());
    queue = settings.shuffle ? [...shuffle(rev), ...shuffle(nw)] : [...rev, ...nw];
  }
  const map = new Map(cards.map((c) => [c.id, c]));
  queue = queue.map((c) => c.id);

  if (!queue.length) {
    view.innerHTML = `
      <div class="empty big">
        <p>${mode === 'weak' ? '苦手なカードはありません 👍' : '今日の復習はありません 🎉'}</p>
        ${cards.length && mode !== 'all' ? `<a class="btn" href="#/study?scope=${scope}${id ? `&id=${id}` : ''}&mode=all">全カードを練習する</a>` : ''}
        <a class="btn ghost" href="${back}">戻る</a>
      </div>`;
    return;
  }

  let idx = 0;
  const stats = { again: 0, hard: 0, good: 0, easy: 0 };
  const seen = new Set();

  const face = async (text, imgId) => {
    let h = `<div class="rt">${richText(text)}</div>`;
    if (imgId) {
      const im = await db.get('images', imgId);
      if (im) h += `<img class="card-img" src="${blobUrl(im.blob)}" alt="">`;
    }
    return h;
  };

  const finish = async () => {
    keyHandler = null;
    const n = stats.again + stats.hard + stats.good + stats.easy;
    const firstTry = seen.size;
    view.innerHTML = `
      <section class="hero done">
        <div class="hero-num">${firstTry}<small>枚</small></div>
        <div class="hero-label">おつかれさまでした！（解答 ${n}回）</div>
        <div class="result-grid">
          ${GRADES.map((g) => `<div class="${g.cls}"><b>${stats[g.g]}</b><span>${g.label}</span></div>`).join('')}
        </div>
        <div class="btn-row">
          <a class="btn" href="${back}">戻る</a>
          <a class="btn primary" href="#/">ホームへ</a>
        </div>
      </section>`;
  };

  const show = async () => {
    revokeUrls();
    if (idx >= queue.length) return finish();
    const card = map.get(queue[idx]);
    const remain = queue.length - idx;
    view.innerHTML = `
      <div class="progress"><div style="width:${(idx / queue.length) * 100}%"></div></div>
      <div class="study-meta"><span>残り ${remain}枚</span><span class="st ${statusText(card).cls}">${statusText(card).text}</span><a href="#/edit/${card.id}" class="link small">編集</a></div>
      <article class="flash">
        <div class="side-label">問題</div>
        <div class="face" id="qface">${await face(card.q, card.qImg)}</div>
        <div id="answer" hidden>
          <div class="side-label ans">答え</div>
          <div class="face" id="aface">${await face(card.a, card.aImg)}</div>
        </div>
      </article>
      <div class="study-actions" id="actions">
        <button class="btn primary big block" id="reveal">答えを見る</button>
      </div>`;
    view.querySelectorAll('.card-img').forEach((im) => { im.onclick = () => showImage(im.src); });
    renderMath($('#qface'), settings.math);
    const reveal = () => {
      $('#answer').hidden = false;
      renderMath($('#aface'), settings.math);
      $('#actions').innerHTML = `<div class="grades">${GRADES.map((g) => `
        <button class="btn grade ${g.cls}" data-g="${g.g}">
          <span class="g-label">${g.label}</span><span class="g-next">${preview(card, g.g, settings).label}</span>
        </button>`).join('')}</div>`;
      $('#actions').querySelectorAll('[data-g]').forEach((b) => { b.onclick = () => grade(b.dataset.g); });
      setTimeout(() => $('#answer').scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 30);
    };
    const grade = async (g) => {
      keyHandler = null;
      const wasNew = card.state === 'new';
      const updated = applyGrade(card, g, settings);
      map.set(card.id, updated);
      await db.put('cards', updated);
      await logReview(g === 'good' || g === 'easy');
      if (wasNew) {
        const used = await newUsedToday();
        await db.kvSet('newToday', { date: today(), count: used + 1 });
      }
      stats[g]++;
      seen.add(card.id);
      if (g === 'again') queue.splice(Math.min(queue.length, idx + 1 + settings.againGap), 0, card.id);
      idx++;
      show();
    };
    $('#reveal').onclick = reveal;
    keyHandler = (e) => {
      if ($('#answer').hidden) { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); reveal(); } return; }
      const k = { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' }[e.key];
      if (k) grade(k);
    };
  };
  show();
}

// ---------------------------------------------------------------- settings
async function requestPersist() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch { /* ignore */ }
}

async function settingsView() {
  setHeader('設定', '#/');
  const perm = notifSupported() ? Notification.permission : 'unsupported';
  let usage = '';
  try {
    const est = await navigator.storage.estimate();
    usage = `${(est.usage / 1024 / 1024).toFixed(1)} MB 使用中`;
  } catch { /* ignore */ }
  let persisted = false;
  try { persisted = await navigator.storage.persisted(); } catch { /* ignore */ }
  const appUrl = location.href.split('#')[0];

  view.innerHTML = `
    <section class="panel">
      <h2>🔔 毎日のリマインド</h2>
      <label class="field-label">通知時刻</label>
      <input type="time" id="rtime" value="${esc(settings.reminderTime)}">
      <h3>① カレンダーに登録（おすすめ・確実）</h3>
      <p class="small">毎日 <b id="rtime-label">${esc(settings.reminderTime)}</b> にアラームが鳴る予定をスマホのカレンダーに追加します。アプリを閉じていても確実に通知されます。</p>
      <button class="btn block" id="ics">📅 カレンダー登録ファイルを作成</button>
      <p class="muted small">iPhone：ダウンロード後に表示される画面で「すべてを追加」→ カレンダーに追加。<br>Android：ファイルを開いて Google カレンダー等に追加。</p>
      <h3>② アプリの通知</h3>
      <p class="small">アプリが起動中・バックグラウンドにある時に、設定時刻に「今日の復習がN枚あります」と通知します（iPhoneはホーム画面に追加＋iOS 16.4以上が必要）。</p>
      <label class="switch"><input type="checkbox" id="notif" ${settings.reminderOn && perm === 'granted' ? 'checked' : ''} ${perm === 'unsupported' ? 'disabled' : ''}><span>アプリの通知を有効にする</span></label>
      <p class="muted small">通知の許可：${{ granted: '許可済み', denied: '拒否されています（端末の設定から許可してください）', default: '未設定', unsupported: 'このブラウザは非対応（ホーム画面に追加して開いてください）' }[perm]}</p>
      <button class="btn small" id="test-notif" ${perm === 'granted' ? '' : 'disabled'}>テスト通知を送る</button>
    </section>

    <section class="panel">
      <h2>🔁 復習の間隔</h2>
      <label class="field-label">「正解」を押すごとに進む復習間隔（日）</label>
      <input id="sched" value="${esc(settings.schedule.join(', '))}" inputmode="numeric">
      <p class="muted small">例：<code>1, 3, 7, 14, 30, 60</code> → 正解するたびに 翌日 → 3日後 → 7日後 … と間隔が伸び、最後を越えると「クリア」。「簡単」は2段階進みます。</p>
      <label class="field-label">「難しい」を押した時の次回（日後）</label>
      <input type="number" id="hard" min="1" max="30" value="${settings.hardDays}">
      <label class="field-label">「もう一度」のカードを何枚後に再出題するか</label>
      <input type="number" id="gap" min="0" max="50" value="${settings.againGap}">
      <label class="field-label">1日に出題する新しいカードの上限（枚）</label>
      <input type="number" id="newper" min="0" max="9999" value="${settings.newPerDay}">
      <label class="switch"><input type="checkbox" id="shuffle" ${settings.shuffle ? 'checked' : ''}><span>出題順をシャッフル</span></label>
      <label class="switch"><input type="checkbox" id="math" ${settings.math ? 'checked' : ''}><span>数式を表示（$...$）</span></label>
      <button class="btn primary block" id="save-srs">保存</button>
    </section>

    <section class="panel">
      <h2>💾 データ</h2>
      <p class="small">データはこのスマホの中だけに保存されています。機種変更・故障に備えて定期的にバックアップしてください。</p>
      <button class="btn block" id="export">バックアップを書き出す</button>
      <label class="btn block">バックアップから復元<input type="file" id="import" accept=".json,application/json" hidden></label>
      <p class="muted small">${usage}${usage ? ' ／ ' : ''}永続保存：${persisted ? '有効' : '未設定'}
        ${persisted ? '' : '<button class="link" id="persist">有効にする</button>'}</p>
    </section>

    <section class="panel">
      <h2>ℹ️ このアプリ</h2>
      <p class="small">診断士 暗記ノート v1.0<br>URL：<span class="mono">${esc(appUrl)}</span></p>
      <button class="btn small ghost danger-text" id="wipe">すべてのデータを削除</button>
    </section>`;

  $('#rtime').onchange = async (e) => {
    settings.reminderTime = e.target.value || '20:00';
    $('#rtime-label').textContent = settings.reminderTime;
    await saveSettings();
    setupReminders();
    toast(`通知時刻を ${settings.reminderTime} にしました`);
  };
  $('#ics').onclick = () => {
    download('anki-reminder.ics', buildICS(settings.reminderTime, appUrl));
  };
  $('#notif').onchange = async (e) => {
    if (e.target.checked) {
      const r = await requestPermission();
      if (r !== 'granted') {
        e.target.checked = false;
        toast('通知が許可されませんでした');
        settings.reminderOn = false;
      } else {
        settings.reminderOn = true;
        toast(`毎日 ${settings.reminderTime} に通知します`);
      }
    } else {
      settings.reminderOn = false;
    }
    await saveSettings();
    setupReminders();
    settingsView();
  };
  $('#test-notif').onclick = async () => {
    const ok = await showReminder(await todayCount(await db.getAll('cards')));
    if (!ok) toast('通知を送れませんでした');
  };
  $('#save-srs').onclick = async () => {
    const sched = parseSchedule($('#sched').value);
    if (!sched) { toast('復習間隔を正しく入力してください'); return; }
    settings.schedule = sched;
    settings.hardDays = Math.max(1, parseInt($('#hard').value, 10) || 1);
    settings.againGap = Math.max(0, parseInt($('#gap').value, 10) || 0);
    const np = parseInt($('#newper').value, 10);
    settings.newPerDay = Number.isNaN(np) ? 30 : Math.max(0, np);
    settings.shuffle = $('#shuffle').checked;
    settings.math = $('#math').checked;
    await saveSettings();
    toast('保存しました');
    settingsView();
  };
  $('#export').onclick = async () => {
    toast('書き出し中…');
    const blob = await exportData();
    download(`anki-backup-${today()}.json`, blob);
    await db.kvSet('lastBackup', today());
  };
  $('#import').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const act = await actionSheet('復元方法', [
      { label: '今のデータに統合する', value: 'merge' },
      { label: '今のデータを消して置き換える', value: 'replace', danger: true },
    ]);
    if (!act) return;
    try {
      const r = await importData(f, act === 'replace');
      await loadSettings();
      toast(`復元しました（フォルダ${r.folders}・カード${r.cards}枚）`);
      location.hash = '#/';
    } catch (err) {
      toast('復元に失敗：' + err.message);
    }
  };
  const ps = $('#persist');
  if (ps) ps.onclick = async () => { await requestPersist(); settingsView(); };
  $('#wipe').onclick = async () => {
    if (!(await confirmDlg('すべての科目・単元・カード・設定を削除します。元に戻せません。', '削除', true))) return;
    if (!(await confirmDlg('本当に削除しますか？', 'すべて削除', true))) return;
    await db.clearAll();
    await loadSettings();
    location.hash = '#/';
  };
}

// ---------------------------------------------------------------- reminders
async function setupReminders() {
  const on = settings.reminderOn && notifSupported() && Notification.permission === 'granted';
  scheduleInApp({ ...settings, reminderOn: on }, async () => todayCount(await db.getAll('cards')));
  if ('serviceWorker' in navigator) registerPeriodicSync(on);
}

// ---------------------------------------------------------------- router
const routes = [
  [/^#?\/?$/, home],
  [/^#\/s\/([^/?]+)$/, subjectView],
  [/^#\/u\/([^/?]+)$/, unitView],
  [/^#\/edit\/([^/?]+)(?:\?(.*))?$/, editView],
  [/^#\/bulk\/([^/?]+)$/, bulkView],
  [/^#\/study\?(.*)$/, studyView],
  [/^#\/settings$/, settingsView],
];

async function route() {
  revokeUrls();
  keyHandler = null;
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  const h = location.hash || '#/';
  for (const [re, fn] of routes) {
    const m = h.match(re);
    if (m) {
      window.scrollTo(0, 0);
      try {
        await fn(...m.slice(1));
      } catch (e) {
        console.error(e);
        view.innerHTML = `<p class="empty">エラーが発生しました：${esc(e.message)}</p>`;
      }
      return;
    }
  }
  location.hash = '#/';
}

document.addEventListener('keydown', (e) => {
  if (keyHandler && !e.target.closest('input,textarea,select,dialog')) keyHandler(e);
});

async function init() {
  await loadSettings();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  }
  window.addEventListener('hashchange', route);
  await route();
  setupReminders();
  // Re-render home when coming back to the app on a new day
  let lastDay = today();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && today() !== lastDay) {
      lastDay = today();
      if (!location.hash.startsWith('#/edit') && !location.hash.startsWith('#/study')) route();
    }
  });
}

init();
