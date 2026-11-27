import { $, el, timeAgo, toast, modal, sheet, confirmModal, promptModal } from './util.js';
import * as T from './transfer.js';
import { api } from './api.js';
import { Editor, newDoc } from './editor.js';

const state = { projects: [], selected: null };

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

window.frameSketch = { editor, state, api, refresh }; // handy from the browser console

window.addEventListener('beforeunload', e => {
  if (!$('#editor').hidden && editor.dirty) { e.preventDefault(); e.returnValue = ''; }
});

// ---------------------------------------------------------------------
async function refresh() {
  try {
    state.projects = await api.listProjects();
  } catch (e) {
    toast((api.mode === 'server' ? 'Could not reach the FrameSketch server: ' : 'Could not read projects from this browser: ') + e.message, true);
    state.projects = [];
  }
  if (state.selected && !state.projects.find(p => p.id === state.selected)) state.selected = null;
  if (!state.selected && state.projects.length) state.selected = state.projects[0].id;
  render();
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function render() {
  const list = $('#projectList');
  list.innerHTML = '';
  $('#projectEmpty').hidden = state.projects.length > 0;
  for (const p of state.projects) {
    const li = el('li', { class: p.id === state.selected ? 'active' : '' },
      el('div', { class: 'grow' },
        el('div', { class: 'name', textContent: p.name }),
        el('div', { class: 'meta', textContent: `${plural(p.saves.length, 'save')} · ${p.width || '?'}×${p.height || '?'} · ${timeAgo(p.updated)}` })),
      el('div', { class: 'row-actions' },
        el('button', { class: 'primary', textContent: 'Open', onclick: e => { e.stopPropagation(); openLatest(p); } })),
    );
    li.addEventListener('click', () => { state.selected = p.id; render(); });
    li.addEventListener('dblclick', () => openLatest(p));
    list.append(li);
  }

  const p = state.projects.find(x => x.id === state.selected);
  $('#projectActions').hidden = !p;
  $('#savesTitle').textContent = p ? `Saves — ${p.name}` : 'Saves';
  const sl = $('#saveList');
  sl.innerHTML = '';
  $('#saveEmpty').hidden = !!(p && p.saves.length);
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
  const p = await api.createProject(name, newDoc({ width, height, background: r.background }));
  state.selected = p.id;
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
  const p = await api.duplicateProject(state.selected);
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
  const p = await T.importProject(api, data);
  state.selected = p.id;
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
