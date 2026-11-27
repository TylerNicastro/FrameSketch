import { $, el, timeAgo, toast, modal, confirmModal, promptModal } from './util.js';
import { api } from './api.js';
import { Editor, newDoc } from './editor.js';

const state = { projects: [], selected: null };

const editor = new Editor({
  onBack: async () => {
    if (editor.dirty) {
      const ok = await confirmModal('Unsaved changes', 'Leave the editor and discard unsaved changes?', 'Discard & leave');
      if (!ok) return;
    }
    editor.close();
    $('#home').hidden = false;
    await refresh();
  },
});

window.frameSketch = { editor, state, api }; // handy from the browser console

window.addEventListener('beforeunload', e => {
  if (!$('#editor').hidden && editor.dirty) { e.preventDefault(); e.returnValue = ''; }
});

// ---------------------------------------------------------------------
async function refresh() {
  try {
    state.projects = await api.listProjects();
  } catch (e) {
    toast('Could not reach the FrameSketch server: ' + e.message, true);
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

refresh();
