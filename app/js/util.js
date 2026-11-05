// UI helpers
export const $ = (sel, root = document) => root.querySelector(sel);

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Plain text -> safe HTML. **bold** supported. Line breaks via CSS pre-wrap.
export function richText(s) {
  return esc(s).replace(/\*\*(.+?)\*\*/gs, '<strong>$1</strong>');
}

export function snippet(s, n = 60) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// ---------- KaTeX (lazy) ----------
const KATEX = 'vendor/katex/'; // KaTeX 0.16.11 (MIT), bundled for offline use
let katexP;
function loadKatex() {
  if (katexP) return katexP;
  katexP = new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = KATEX + 'katex.min.css';
    document.head.appendChild(link);
    const s1 = document.createElement('script');
    s1.src = KATEX + 'katex.min.js';
    s1.onload = () => {
      const s2 = document.createElement('script');
      s2.src = KATEX + 'contrib/auto-render.min.js';
      s2.onload = resolve;
      s2.onerror = reject;
      document.head.appendChild(s2);
    };
    s1.onerror = reject;
    document.head.appendChild(s1);
  }).catch((e) => { katexP = null; throw e; });
  return katexP;
}

export async function renderMath(el, enabled) {
  if (!enabled || !el || !el.textContent.includes('$')) return;
  try {
    await loadKatex();
    window.renderMathInElement(el, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
      ],
      throwOnError: false,
      strict: 'ignore',
    });
  } catch { /* offline & not cached: leave raw text */ }
}

// ---------- Images ----------
export async function compressImage(file, maxSide = 1600, quality = 0.85) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bmp = await new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = URL.createObjectURL(file);
    });
  }
  const w = bmp.width, h = bmp.height;
  const r = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * r);
  canvas.height = Math.round(h * r);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise((res) => canvas.toBlob((b) => res(b || file), 'image/jpeg', quality));
}

// Object URLs created for the current screen; revoked on navigation
const urls = new Set();
export function blobUrl(blob) {
  const u = URL.createObjectURL(blob);
  urls.add(u);
  return u;
}
export function revokeUrls() {
  for (const u of urls) URL.revokeObjectURL(u);
  urls.clear();
}

// ---------- Dialogs ----------
function makeDialog(inner) {
  const d = document.createElement('dialog');
  d.className = 'dlg';
  d.innerHTML = inner;
  document.body.appendChild(d);
  d.addEventListener('close', () => setTimeout(() => d.remove(), 0));
  d.showModal();
  return d;
}

export function promptText(title, value = '', placeholder = '') {
  return new Promise((resolve) => {
    const d = makeDialog(`
      <form method="dialog">
        <h3>${esc(title)}</h3>
        <input name="v" value="${esc(value)}" placeholder="${esc(placeholder)}" maxlength="60" autocomplete="off">
        <div class="dlg-btns">
          <button value="ok" class="btn primary">OK</button>
          <button value="cancel" formnovalidate class="btn ghost">キャンセル</button>
        </div>
      </form>`);
    const input = d.querySelector('input');
    setTimeout(() => input.focus(), 50);
    d.addEventListener('close', () => {
      const v = input.value.trim();
      resolve(d.returnValue === 'ok' && v ? v : null);
    });
  });
}

export function confirmDlg(message, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    const d = makeDialog(`
      <form method="dialog">
        <p class="dlg-msg">${esc(message)}</p>
        <div class="dlg-btns">
          <button value="ok" class="btn ${danger ? 'danger' : 'primary'}">${esc(okLabel)}</button>
          <button value="cancel" class="btn ghost">キャンセル</button>
        </div>
      </form>`);
    d.addEventListener('close', () => resolve(d.returnValue === 'ok'));
  });
}

// actions: [{label, value, danger}]
export function actionSheet(title, actions) {
  return new Promise((resolve) => {
    const d = makeDialog(`
      <form method="dialog" class="sheet">
        ${title ? `<h3>${esc(title)}</h3>` : ''}
        ${actions.map((a) => `<button value="${esc(a.value)}" class="btn block ${a.danger ? 'danger-text' : ''}">${esc(a.label)}</button>`).join('')}
        <button value="" class="btn block ghost">閉じる</button>
      </form>`);
    d.addEventListener('click', (e) => { if (e.target === d) d.close(''); });
    d.addEventListener('close', () => resolve(d.returnValue || null));
  });
}

export function choose(title, options) {
  return actionSheet(title, options.map((o) => ({ label: o.label, value: o.value })));
}

let toastTimer;
export function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

export function showImage(url) {
  const d = makeDialog(`<img src="${esc(url)}" alt="">`);
  d.classList.add('img-viewer');
  d.addEventListener('click', () => d.close());
}

export function download(filename, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}
