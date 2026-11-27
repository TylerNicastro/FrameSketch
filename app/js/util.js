export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const uid = () =>
  Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) e.append(c);
  return e;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function timeAgo(ms) {
  if (!ms) return '';
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleString();
}

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function hexToRgba(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
}

export function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

export function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

// ---------------- toast ----------------
let toastTimer;
export function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 4500 : 2200);
}

// ---------------- modal ----------------
/**
 * Show a modal. `fields` is a list of {name, label, type, value, min, max, options}.
 * Resolves with an object of field values, true (no fields), or null if cancelled.
 */
export function modal({ title, message = '', fields = [], okText = 'OK', danger = false }) {
  const back = $('#modal');
  const form = $('#modalForm');
  const body = $('#modalBody');
  $('#modalTitle').textContent = title;
  body.innerHTML = '';
  if (message) body.append(el('p', { textContent: message }));
  const grid = fields.length > 2 && fields.every(f => f.half) ? el('div', { class: 'grid2' }) : body;
  if (grid !== body) body.append(grid);
  for (const f of fields) {
    let input;
    if (f.type === 'select') {
      input = el('select', { name: f.name }, f.options.map(o => el('option', { value: o.value, textContent: o.label, selected: o.value === f.value })));
    } else {
      input = el('input', { name: f.name, type: f.type || 'text', value: f.value ?? '' });
      if (f.min != null) input.min = f.min;
      if (f.max != null) input.max = f.max;
      if (f.step != null) input.step = f.step;
      if (f.required) input.required = true;
    }
    grid.append(el('label', {}, f.label, input));
  }
  const ok = $('#modalOk');
  ok.textContent = okText;
  ok.className = danger ? 'danger primary' : 'primary';
  back.hidden = false;
  const first = body.querySelector('input, select');
  setTimeout(() => (first ? (first.focus(), first.select?.()) : ok.focus()), 0);

  return new Promise(resolve => {
    const done = val => {
      back.hidden = true;
      form.onsubmit = null;
      $('#modalCancel').onclick = null;
      back.onkeydown = null;
      resolve(val);
    };
    form.onsubmit = e => {
      e.preventDefault();
      if (!fields.length) return done(true);
      const out = {};
      for (const f of fields) {
        const v = form.elements[f.name].value;
        out[f.name] = f.type === 'number' ? Number(v) : v;
      }
      done(out);
    };
    $('#modalCancel').onclick = () => done(null);
    back.onkeydown = e => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
  });
}

export const confirmModal = (title, message, okText = 'Delete') =>
  modal({ title, message, okText, danger: true });

export async function promptModal(title, label, value = '') {
  const r = await modal({ title, fields: [{ name: 'v', label, value, required: true }] });
  return r ? r.v.trim() || null : null;
}

export const isModalOpen = () => !$('#modal').hidden;
