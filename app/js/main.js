import { $, el, timeAgo, toast, modal, sheet, confirmModal, promptModal } from './util.js';
import * as T from './transfer.js';
import { api } from './api.js';
import * as L from './library.js';
import { Editor, newDoc } from './editor.js';

const state = { projects: [], selected: null, selFolder: null, lib: L.normalize(null, []).lib };

// how the list is shown: a per-device preference, not part of any project
const VIEW_KEY = 'framesketch.home';
const view = (() => {
  let v = {};
  try { v = JSON.parse(localStorage.getItem(VIEW_KEY)) || {}; } catch { /* storage blocked */ }
  return { sort: L.SORTS[v.sort] ? v.sort : 'order', invert: !!v.invert, collapsed: new Set(Array.isArray(v.collapsed) ? v.collapsed : []) };
})();
function saveView() {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify({ sort: view.sort, invert: view.invert, collapsed: [...view.collapsed] })); } catch { /* storage blocked */ }
}

const editor = new Editor({
  onBack: async () => {
    if (editor.dirty && editor.autoSaveOn) await editor.save({ quiet: true }); // auto-save: just save on the way out
    if (editor.dirty) {
      const ok = await confirmModal('Unsaved changes', 'Leave the editor and discard unsaved changes?', 'Discard & leave');
      if (!ok) return;
    }
    editor.close();
    $('#home').hidden = false;
    await refresh();
  },
});

window.frameSketch = { editor, state, view, api, refresh }; // handy from the browser console

window.addEventListener('beforeunload', e => {
  if (!$('#editor').hidden && editor.dirty) { e.preventDefault(); e.returnValue = ''; }
});

// ---------------------------------------------------------------------
async function refresh() {
  let stored = {};
  try {
    [state.projects, stored] = await Promise.all([api.listProjects(), api.getLibrary().catch(() => ({}))]);
  } catch (e) {
    toast((api.mode === 'server' ? 'Could not reach the FrameSketch server: ' : 'Could not read projects from this browser: ') + e.message, true);
    state.projects = [];
  }
  const { lib, changed } = L.normalize(stored, state.projects);
  state.lib = lib;
  if (changed && state.projects.length) api.setLibrary(lib).catch(() => {});
  if (state.selected && !state.projects.find(p => p.id === state.selected)) state.selected = null;
  if (state.selFolder && !lib.folders[state.selFolder]) state.selFolder = null;
  if (!state.selected && !state.selFolder) {
    const first = rows().find(r => r.node.kind === 'project');
    if (first) state.selected = first.node.id;
  }
  render();
}

/** Store a changed library (folders / order) and redraw. */
async function setLib(lib) {
  if (!lib) return false;
  state.lib = lib;
  render();
  try { await api.setLibrary(lib); } catch (e) { toast('Could not save the folder layout: ' + e.message, true); }
  return true;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
/** 4.5 s, 1:05, 1:02:03 */
const fmtLen = s => {
  if (s < 60) return `${Math.round(s * 10) / 10} s`;
  const t = Math.round(s), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, ss = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

const rows = () => L.flatten(L.buildTree(state.lib, state.projects, view.sort, view.invert), view.collapsed);
const selRef = () => (state.selFolder ? L.fref(state.selFolder) : state.selected ? L.pref(state.selected) : null);
/** Where new things go: the selected folder, or the folder of the selected project. */
const currentFolder = () => state.selFolder
  || (state.selected && L.parentOf(state.lib, L.pref(state.selected))) || L.ROOT;

const INVERT_LABEL = {
  order: ['As arranged', 'Reversed'],
  name: ['A → Z', 'Z → A'],
  modified: ['Newest first', 'Oldest first'],
  length: ['Longest first', 'Shortest first'],
};

function select(kind, id) {
  state.selected = kind === 'project' ? id : null;
  state.selFolder = kind === 'folder' ? id : null;
  render();
}

function toggleFolder(id, open = view.collapsed.has(id)) {
  if (open) view.collapsed.delete(id); else view.collapsed.add(id);
  saveView();
  render();
}

function renderTree() {
  $('#projectSort').value = view.sort;
  const inv = $('#btnSortInvert');
  inv.textContent = (view.invert ? '↑ ' : '↓ ') + INVERT_LABEL[view.sort][view.invert ? 1 : 0];
  inv.setAttribute('aria-pressed', String(view.invert));

  const list = $('#projectList');
  const keepScroll = list.scrollTop;
  list.innerHTML = '';
  const all = rows();
  $('#projectEmpty').hidden = all.length > 0;
  const sel = selRef();
  for (const { node, depth } of all) {
    const folder = node.kind === 'folder';
    const open = folder && !view.collapsed.has(node.id);
    const p = node.project;
    const meta = folder
      ? `${node.count ? plural(node.count, 'project') : 'Empty'}${node.duration ? ' · ' + fmtLen(node.duration) : ''}`
      : `${plural(p.saves.length, 'save')} · ${fmtLen(node.duration)} · ${p.width || '?'}×${p.height || '?'} · ${timeAgo(p.updated)}`;
    const li = el('li', { class: `${folder ? 'folder' : 'project'}${node.ref === sel ? ' active' : ''}`, style: `--depth:${depth}` },
      el('span', { class: 'drag', title: 'Drag to move', textContent: '⠿' }),
      folder
        ? el('button', { class: 'caret', title: open ? 'Collapse' : 'Expand', textContent: open ? '▾' : '▸', onclick: e => { e.stopPropagation(); toggleFolder(node.id); } })
        : '',
      el('div', { class: 'grow' },
        el('div', { class: 'name', textContent: (folder ? '📁 ' : '') + node.name }),
        el('div', { class: 'meta', textContent: meta })),
      folder ? '' : el('div', { class: 'row-actions' },
        el('button', { class: 'primary', textContent: 'Open', onclick: e => { e.stopPropagation(); openLatest(p); } })),
    );
    li.dataset.ref = node.ref;
    li.addEventListener('click', () => select(node.kind, node.id));
    li.addEventListener('dblclick', () => (folder ? toggleFolder(node.id) : openLatest(p)));
    li.querySelector('.drag').addEventListener('pointerdown', e => startDrag(e, node));
    list.append(li);
  }
  list.scrollTop = keepScroll;
}

function render() {
  renderTree();
  const f = state.selFolder && state.lib.folders[state.selFolder];
  $('#folderActions').hidden = !f;
  const p = state.projects.find(x => x.id === state.selected);
  $('#projectActions').hidden = !p;
  $('#savesTitle').textContent = p ? `Saves — ${p.name}` : f ? `Folder — ${f.name}` : 'Saves';
  const sl = $('#saveList');
  sl.innerHTML = '';
  $('#saveEmpty').hidden = !!(p && p.saves.length);
  if (f) {
    const node = rows().find(r => r.node.ref === L.fref(state.selFolder))?.node;
    const n = node?.count || 0;
    $('#saveEmpty').textContent = n
      ? `${plural(n, 'project')} inside${node.duration ? `, ${fmtLen(node.duration)} in total` : ''}. New projects and folders go into this folder.`
      : 'This folder is empty. Drag projects onto it, or create a new project while it is selected.';
    return;
  }
  $('#saveEmpty').textContent = p ? 'This project has no saves.' : 'Select a project to see its saves.';
  if (!p) return;

  p.saves.forEach((s, i) => {
    const li = el('li', {},
      el('div', { class: 'grow' },
        el('div', { class: 'name', textContent: s.name + (i === 0 ? '  (latest)' : '') }),
        el('div', { class: 'meta', textContent: `${plural(s.frames || 0, 'frame')} · saved ${timeAgo(s.updated)}` })),
      el('div', { class: 'row-actions' },
        el('button', { class: 'primary', textContent: 'Open', onclick: e => { e.stopPropagation(); openSave(p, s); } }),
        el('button', { textContent: 'Rename', onclick: e => { e.stopPropagation(); renameSave(p, s); } }),
        el('button', { textContent: 'Duplicate', onclick: e => { e.stopPropagation(); duplicateSave(p, s); } }),
        el('button', { class: 'danger', textContent: 'Delete', onclick: e => { e.stopPropagation(); deleteSave(p, s); } })),
    );
    li.addEventListener('dblclick', () => openSave(p, s));
    sl.append(li);
  });
  sl.append(el('li', { class: 'muted', onclick: () => newBlankSave(p) }, '+ New blank save'));
}

// ---------------------------------------------------------------------
const run = fn => async (...args) => {
  try { await fn(...args); } catch (e) { toast(e.message, true); }
};

const openSave = run(async (p, s) => {
  toast('Opening…');
  await editor.open(p, s);
  $('#toast').hidden = true;
});

const openLatest = run(async p => {
  if (!p.saves.length) return newBlankSave(p);
  await openSave(p, p.saves[0]);
});

const newProject = run(async () => {
  const r = await modal({
    title: 'New project',
    okText: 'Create',
    fields: [
      { name: 'name', label: 'Project name', value: 'Untitled project', required: true },
      {
        name: 'size', label: 'Canvas size', type: 'select', value: '1280x720', options: [
          { value: '1280x720', label: '1280 × 720 (HD 16:9)' },
          { value: '1920x1080', label: '1920 × 1080 (Full HD 16:9)' },
          { value: '1080x1080', label: '1080 × 1080 (square)' },
          { value: '1080x1920', label: '1080 × 1920 (vertical)' },
          { value: '1600x1200', label: '1600 × 1200 (4:3)' },
          { value: '2048x858', label: '2048 × 858 (cinemascope)' },
          { value: 'custom', label: 'Custom…' },
        ],
      },
      {
        name: 'background', label: 'Background', type: 'select', value: '#ffffff', options: [
          { value: '#ffffff', label: 'White' },
          { value: '#f4efe6', label: 'Paper' },
          { value: '#808080', label: 'Mid gray' },
          { value: '#000000', label: 'Black' },
          { value: 'transparent', label: 'Transparent' },
        ],
      },
    ],
  });
  if (!r) return;
  let [width, height] = r.size.split('x').map(Number);
  if (r.size === 'custom') {
    const c = await modal({
      title: 'Custom canvas size', okText: 'Create',
      fields: [
        { name: 'w', label: 'Width (px)', type: 'number', value: 1280, min: 16, max: 8192, required: true },
        { name: 'h', label: 'Height (px)', type: 'number', value: 720, min: 16, max: 8192, required: true },
      ],
    });
    if (!c) return;
    width = Math.round(Math.min(8192, Math.max(16, c.w)));
    height = Math.round(Math.min(8192, Math.max(16, c.h)));
  }
  const name = r.name.trim() || 'Untitled project';
  const folder = currentFolder();
  const p = await api.createProject(name, newDoc({ width, height, background: r.background }));
  await setLib(L.move(state.lib, L.pref(p.id), folder, 0));
  state.selected = p.id;
  state.selFolder = null;
  await openSave(p, p.saves[0]);
});

const renameProject = run(async () => {
  const p = state.projects.find(x => x.id === state.selected);
  const name = await promptModal('Rename project', 'Project name', p.name);
  if (!name) return;
  await api.renameProject(p.id, name);
  await refresh();
});

const duplicateProject = run(async () => {
  const orig = state.selected;
  const p = await api.duplicateProject(orig);
  await setLib(L.placeAfter(state.lib, L.pref(p.id), L.pref(orig)));
  state.selected = p.id;
  toast(`Duplicated as "${p.name}"`);
  await refresh();
});

const deleteProject = run(async () => {
  const p = state.projects.find(x => x.id === state.selected);
  if (!await confirmModal('Delete project', `Delete "${p.name}" and all ${plural(p.saves.length, 'save')}? This can't be undone.`)) return;
  await api.deleteProject(p.id);
  state.selected = null;
  await refresh();
});

const renameSave = run(async (p, s) => {
  const name = await promptModal('Rename save', 'Save name', s.name);
  if (!name) return;
  await api.renameSave(p.id, s.id, name);
  await refresh();
});

const duplicateSave = run(async (p, s) => {
  await api.duplicateSave(p.id, s.id);
  await refresh();
});

const deleteSave = run(async (p, s) => {
  if (!await confirmModal('Delete save', `Delete the save "${s.name}"? This can't be undone.`)) return;
  await api.deleteSave(p.id, s.id);
  await refresh();
});

const newBlankSave = run(async p => {
  const name = await promptModal('New blank save', 'Save name', `Save ${p.saves.length + 1}`);
  if (!name) return;
  const doc = newDoc({ width: p.width || 1280, height: p.height || 720, background: p.background || '#ffffff' });
  const s = await api.createSave(p.id, name, doc);
  await openSave(p, s);
});

// ---------------------------------------------------------------------
// folders, moving and sorting
const newFolder = run(async () => {
  const name = await promptModal('New folder', 'Folder name', 'New folder');
  if (!name?.trim()) return;
  const parent = currentFolder();
  const { lib, id } = L.addFolder(state.lib, name.trim(), parent, 0);
  if (parent !== L.ROOT) view.collapsed.delete(parent);
  saveView();
  state.selFolder = id;
  state.selected = null;
  await setLib(lib);
});

const renameFolder = run(async () => {
  const f = state.lib.folders[state.selFolder];
  if (!f) return;
  const name = await promptModal('Rename folder', 'Folder name', f.name);
  if (!name?.trim()) return;
  await setLib(L.renameFolder(state.lib, state.selFolder, name.trim()));
});

const deleteFolder = run(async () => {
  const id = state.selFolder, f = state.lib.folders[id];
  if (!f) return;
  const parent = L.parentOf(state.lib, L.fref(id));
  const where = parent && parent !== L.ROOT ? `"${state.lib.folders[parent].name}"` : 'the top level';
  const inside = state.lib.order[id]?.length || 0;
  if (inside && !await confirmModal('Delete folder', `Delete the folder "${f.name}"? Nothing inside is deleted: its ${plural(inside, 'item')} move to ${where}.`, 'Delete folder')) return;
  state.selFolder = null;
  await setLib(L.deleteFolder(state.lib, id));
});

/** "Move to…" dialog: pick a folder (works without dragging, e.g. on small phones). */
const moveDialog = run(async ref => {
  if (!ref) return;
  const { kind, id } = L.parseRef(ref);
  const options = [{ value: L.ROOT, label: 'Top level' }];
  const walk = (cid, depth) => {
    for (const r of state.lib.order[cid] || []) {
      const x = L.parseRef(r);
      if (x.kind !== 'folder' || (kind === 'folder' && x.id === id)) continue; // not into itself
      options.push({ value: x.id, label: `${' '.repeat(depth)}📁 ${state.lib.folders[x.id].name}` });
      walk(x.id, depth + 1);
    }
  };
  walk(L.ROOT, 1);
  const name = kind === 'folder' ? state.lib.folders[id].name : state.projects.find(p => p.id === id)?.name;
  const r = await modal({
    title: `Move "${name}"`, okText: 'Move',
    fields: [{ name: 'to', label: 'Move to', type: 'select', value: L.parentOf(state.lib, ref) || L.ROOT, options }],
  });
  if (!r) return;
  if (r.to !== L.ROOT) view.collapsed.delete(r.to);
  saveView();
  await setLib(L.move(state.lib, ref, r.to, 0));
});

/** Reordering only makes sense in the custom order, so switch to it first. */
function useCustomOrder() {
  if (view.sort === 'order') return;
  view.sort = 'order';
  view.invert = false;
  saveView();
  toast('Switched to Custom order to arrange items.');
}

/** Alt+↑ / Alt+↓: move the selected item one place within its folder. */
const nudge = run(async delta => {
  const ref = selRef();
  const cid = ref && L.parentOf(state.lib, ref);
  if (!cid) return;
  useCustomOrder();
  const list = state.lib.order[cid];
  const i = list.indexOf(ref), j = i + (view.invert ? -delta : delta);
  if (j < 0 || j >= list.length) return render();
  await setLib(L.move(state.lib, ref, cid, j + (j > i ? 1 : 0)));
});

// Drag a row by its handle: drop above / below another row to reorder, or onto a folder to put
// it inside. Pointer events, so it works with a mouse, a pen and a finger alike.
function startDrag(e, node) {
  if (e.button > 0) return;
  e.preventDefault();
  e.stopPropagation();
  const list = $('#projectList');
  const src = e.target.closest('li');
  let drop = null, raf = 0, lastY = e.clientY, started = false;
  const x0 = e.clientX, y0 = e.clientY;
  try { e.target.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
  const clear = () => list.querySelectorAll('.drop-before, .drop-after, .drop-into')
    .forEach(n => n.classList.remove('drop-before', 'drop-after', 'drop-into'));
  const where = (x, y) => {
    const li = document.elementFromPoint(x, y)?.closest?.('#projectList li[data-ref]');
    if (!li) { // below the last row: the end of the top level
      const r = list.getBoundingClientRect();
      const bottom = list.lastElementChild?.getBoundingClientRect().bottom ?? r.top;
      return y > bottom && y < r.bottom + 40 && x > r.left && x < r.right ? { end: true } : null;
    }
    const ref = li.dataset.ref, t = L.parseRef(ref);
    if (ref === node.ref) return null;
    // a folder can't go into itself or anything inside it
    if (node.kind === 'folder' && L.isWithin(state.lib, t.kind === 'folder' ? t.id : L.parentOf(state.lib, ref), node.id)) return null;
    const r = li.getBoundingClientRect(), f = (y - r.top) / r.height;
    const pos = t.kind === 'folder' ? (f < 0.25 ? 'before' : f > 0.75 ? 'after' : 'into') : (f < 0.5 ? 'before' : 'after');
    return { li, ref, pos };
  };
  const autoScroll = () => {
    const r = list.getBoundingClientRect();
    if (lastY < r.top + 36) list.scrollTop -= 12; else if (lastY > r.bottom - 36) list.scrollTop += 12;
    raf = requestAnimationFrame(autoScroll);
  };
  const onMove = ev => {
    lastY = ev.clientY;
    if (!started) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      started = true;
      src.classList.add('dragging');
      document.body.classList.add('dragging-rows');
      raf = requestAnimationFrame(autoScroll);
    }
    clear();
    drop = where(ev.clientX, ev.clientY);
    if (drop?.li) drop.li.classList.add('drop-' + drop.pos);
    else if (drop?.end) list.lastElementChild?.classList.add('drop-after');
  };
  const onUp = async () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    cancelAnimationFrame(raf);
    clear();
    src.classList.remove('dragging');
    document.body.classList.remove('dragging-rows');
    if (started && drop) await dropAt(node.ref, drop);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

/** Apply a drop: { ref, pos: before | after | into } or { end } (the end of the top level). */
const dropAt = run(async (ref, drop) => {
  if (drop.pos === 'into') {
    const fid = L.parseRef(drop.ref).id;
    view.collapsed.delete(fid);
    saveView();
    return setLib(L.move(state.lib, ref, fid, view.sort === 'order' && view.invert ? 0 : undefined));
  }
  useCustomOrder();
  if (drop.end) return setLib(L.move(state.lib, ref, L.ROOT, view.invert ? 0 : undefined));
  const cid = L.parentOf(state.lib, drop.ref);
  const after = (drop.pos === 'after') !== view.invert; // a reversed list shows "after" above
  return setLib(L.move(state.lib, ref, cid, state.lib.order[cid].indexOf(drop.ref) + (after ? 1 : 0)));
});

$('#projectSort').addEventListener('change', e => { view.sort = e.target.value; view.invert = false; saveView(); render(); });
$('#btnSortInvert').addEventListener('click', () => { view.invert = !view.invert; saveView(); render(); });
$('#btnNewFolder').addEventListener('click', newFolder);
$('#btnRenameFolder').addEventListener('click', renameFolder);
$('#btnDeleteFolder').addEventListener('click', deleteFolder);
$('#btnMoveFolder').addEventListener('click', () => moveDialog(selRef()));
$('#btnMoveProject').addEventListener('click', () => moveDialog(selRef()));
window.addEventListener('keydown', e => {
  if ($('#home').hidden || !$('#modal').hidden || document.querySelector('.sheet-back')) return;
  if (e.target.matches?.('input, textarea, select')) return;
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); nudge(e.key === 'ArrowUp' ? -1 : 1); }
  else if (e.key === 'F2' && state.selFolder) renameFolder();
  else if (e.key === 'ArrowRight' && state.selFolder) toggleFolder(state.selFolder, true);
  else if (e.key === 'ArrowLeft' && state.selFolder) toggleFolder(state.selFolder, false);
});

$('#btnNewProject').addEventListener('click', newProject);
$('#btnRenameProject').addEventListener('click', renameProject);
$('#btnDuplicateProject').addEventListener('click', duplicateProject);
$('#btnDeleteProject').addEventListener('click', deleteProject);

// ---------------------------------------------------------------------
// moving projects between devices: one compressed .fsk file (or the same thing as text)
const mb = n => (n < 104858 ? `${Math.max(1, Math.round(n / 1024))} KB`
  : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(1)} GB`);

function downloadBlob(blob, name) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back below */ }
  const ta = el('textarea', { value: text, style: 'position:fixed;left:-9999px' });
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* not allowed */ }
  ta.remove();
  return ok;
}

const exportProject = run(async () => {
  const p = state.projects.find(x => x.id === state.selected);
  if (!p) return;
  toast('Packing the project…');
  const data = await T.collectProject(api, p);
  const bytes = await T.pack(data);
  $('#toast').hidden = true;
  const name = T.fileName(p.name);
  const fsk = new File([bytes], name, { type: 'application/octet-stream' });
  let text = null;
  const getText = () => (text ??= T.toText(bytes));
  const txtFile = () => new File([getText()], name + '.txt', { type: 'text/plain' });
  const canShare = f => { try { return !!navigator.canShare?.({ files: [f] }); } catch { return false; } };
  const share = async () => {
    // some phones only share known file types; the text form in a .txt works everywhere
    const f = canShare(fsk) ? fsk : txtFile();
    try { await navigator.share({ files: [f], title: p.name }); toast('Shared. Open it in FrameSketch on the other device with Import.'); }
    catch (e) { if (e.name !== 'AbortError') toast('Could not share: ' + e.message, true); return false; }
  };
  const buttons = [];
  if (navigator.share && (canShare(fsk) || canShare(new File(['x'], 'x.txt', { type: 'text/plain' })))) {
    buttons.push({ label: 'Share…', title: 'Send it with AirDrop, Messages, email, Drive, Discord…', onClick: share });
  }
  buttons.push({ label: 'Copy as text', title: 'Paste it into a note, chat or email, then paste it into Import on the other device', onClick: async () => {
    const t = getText();
    if (await copyText(t)) toast(`Copied ${mb(t.length)} of text. On the other device: Import → Paste text.`);
    else { toast('Copying was blocked by the browser. Use Download or Share instead.', true); return false; }
  } });
  buttons.push({ label: 'Download file', primary: true, onClick: () => { downloadBlob(fsk, name); toast(`Downloaded ${name}`); } });
  const big = bytes.length > 15 * 1048576;
  await sheet({
    title: `Export "${p.name}"`,
    body: [
      el('p', { textContent: `All ${plural(p.saves.length, 'save')}, drawings and audio in one ${mb(bytes.length)} file. Open it on another device with Import (it works on phones too).` }),
      el('p', { class: 'muted small', textContent: big
        ? 'This project is large, so the text version may be too long for some chat apps. A file is the safer way.'
        : 'The text version is the same project written as letters, handy for pasting into a note or message.' }),
    ],
    buttons,
  });
});

const importData = run(async input => {
  toast('Reading the project…');
  const data = await T.unpack(input);
  toast('Importing…');
  const folder = currentFolder();
  const p = await T.importProject(api, data);
  await setLib(L.move(state.lib, L.pref(p.id), folder, 0));
  state.selected = p.id;
  state.selFolder = null;
  await refresh();
  toast(`Imported "${p.name}" with ${plural(p.saves.length, 'save')}`);
});

const importDialog = run(async () => {
  const ta = el('textarea', { rows: 5, placeholder: 'Paste project text here (starts with FSK1:)…', spellcheck: false });
  const pasteBtn = el('button', { type: 'button', textContent: 'Paste from clipboard', onclick: async () => {
    try { ta.value = await navigator.clipboard.readText(); } catch { toast('Long-press the box and choose Paste instead.', true); }
  } });
  const r = await sheet({
    title: 'Import a project',
    body: [
      el('p', { textContent: 'Choose a .fsk file (or an older .framesketch.json backup), or paste project text copied with Export → Copy as text.' }),
      el('div', { class: 'btn-row' },
        el('button', { type: 'button', class: 'primary', textContent: 'Choose file…', onclick: () => { $('#importFile').click(); document.querySelector('.sheet-back .btn-row.end button')?.click(); } }),
        navigator.clipboard?.readText ? pasteBtn : ''),
      ta,
    ],
    buttons: [{ label: 'Import text', value: 'text' }],
  });
  if (r === 'text') {
    if (!ta.value.trim()) { toast('Paste the project text first.', true); return; }
    await importData(ta.value);
  }
});

$('#btnBackupProject').addEventListener('click', exportProject);
$('#btnImport').addEventListener('click', importDialog);
$('#importFile').addEventListener('change', e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) importData(f);
});

// drop a project file anywhere on the home screen, or paste project text there
const home = $('#home');
home.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); home.classList.add('drop-target'); } });
home.addEventListener('dragleave', e => { if (e.target === home) home.classList.remove('drop-target'); });
home.addEventListener('drop', e => {
  home.classList.remove('drop-target');
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  e.preventDefault();
  importData(f);
});
window.addEventListener('paste', e => {
  if (home.hidden || document.querySelector('.sheet-back') || !$('#modal').hidden) return;
  if (e.target.matches?.('input, textarea')) return;
  const f = e.clipboardData?.files?.[0];
  const t = e.clipboardData?.getData('text/plain') || '';
  if (f) { e.preventDefault(); importData(f); } else if (t.trim().startsWith('FSK1:')) { e.preventDefault(); importData(t); }
});

async function storageUsage() {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est?.quota) return '';
    return ` Using ${mb(est.usage || 0)} of about ${mb(est.quota)} available here.`;
  } catch { return ''; }
}

// ---------------------------------------------------------------------
async function start() {
  const mode = await api.init();
  editor.storageMode = mode;
  $('#storageNote').textContent = mode === 'server'
    ? 'Projects are saved as files in the data/ folder on this computer.'
    : 'Projects are saved in this browser on this device. Use Export to keep a copy or move a project to another device.' + await storageUsage();
  document.body.classList.toggle('local-mode', mode === 'local');
  await refresh();
}
start();

// installable app + offline use (not under the local server, where files change while you work)
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
