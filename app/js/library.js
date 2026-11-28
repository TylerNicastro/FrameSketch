// Folders and custom order for the home screen.
//
// Stored apart from the projects themselves, as one small object:
//   { version: 1,
//     folders: { <folderId>: { name, created } },
//     order:   { root: [ref, …], <folderId>: [ref, …] } }
// where a ref is 'p:<projectId>' or 'f:<folderId>'. The order lists are the only record of what
// is inside what, so an item is always in exactly one place. normalize() repairs anything odd
// (deleted projects, new projects, loops) every time the list is loaded.

export const ROOT = 'root';
export const pref = id => 'p:' + id;
export const fref = id => 'f:' + id;
export const parseRef = r => ({ kind: r[0] === 'f' ? 'folder' : 'project', id: r.slice(2) });

export const SORTS = {
  order: 'Custom order',
  name: 'Name',
  modified: 'Last modified',
  length: 'Length',
};

const clone = lib => ({ version: 1, folders: { ...lib.folders }, order: Object.fromEntries(Object.entries(lib.order).map(([k, v]) => [k, [...v]])) });
const newFolderId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, '0')).join('');

/**
 * Make a stored library consistent with the current projects. Projects that aren't placed yet
 * (new, imported, or from before folders existed) go to the top of the root, newest first.
 * Returns { lib, changed }.
 */
export function normalize(raw, projects) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const folders = {};
  for (const [id, f] of Object.entries(src.folders || {})) {
    if (id !== ROOT && f && typeof f.name === 'string') folders[id] = { name: f.name.slice(0, 120), created: +f.created || 0 };
  }
  const pids = new Set(projects.map(p => p.id));
  const order = {};
  const placed = new Set();
  const visit = cid => {
    const list = (order[cid] = []);
    for (const r of Array.isArray(src.order?.[cid]) ? src.order[cid] : []) {
      if (typeof r !== 'string' || placed.has(r)) continue;
      const { kind, id } = parseRef(r);
      if (kind === 'project' ? !pids.has(id) : !folders[id]) continue;
      placed.add(r);
      list.push(r);
      if (kind === 'folder') visit(id);
    }
  };
  visit(ROOT);
  // folders that were left unreachable (e.g. a loop) come back at the root
  for (const id of Object.keys(folders)) {
    if (!placed.has(fref(id))) { placed.add(fref(id)); order[ROOT].push(fref(id)); visit(id); }
  }
  const fresh = projects.filter(p => !placed.has(pref(p.id)))
    .sort((a, b) => (b.updated || 0) - (a.updated || 0)).map(p => pref(p.id));
  order[ROOT].unshift(...fresh);
  const lib = { version: 1, folders, order };
  return { lib, changed: JSON.stringify(lib) !== JSON.stringify(src) };
}

/** The folder id holding `ref` (ROOT for the top level), or null if it isn't placed. */
export function parentOf(lib, ref) {
  for (const [cid, list] of Object.entries(lib.order)) if (list.includes(ref)) return cid;
  return null;
}

/** Is folder `id` the same as, or inside, folder `ancestor`? */
export function isWithin(lib, id, ancestor) {
  for (let cur = id, guard = 0; cur && cur !== ROOT && guard < 1000; guard++) {
    if (cur === ancestor) return true;
    cur = parentOf(lib, fref(cur));
  }
  return ancestor === ROOT;
}

/**
 * Move `ref` into folder `target` at position `index` (end when omitted). Returns a new library,
 * or null when the move isn't possible (a folder into itself or one of its own folders).
 */
export function move(lib, ref, target, index) {
  const { kind, id } = parseRef(ref);
  if (target !== ROOT && !lib.folders[target]) return null;
  if (kind === 'folder' && isWithin(lib, target, id)) return null;
  const out = clone(lib);
  const from = parentOf(out, ref);
  let at = index ?? Infinity;
  if (from !== null) {
    const list = out.order[from];
    const i = list.indexOf(ref);
    list.splice(i, 1);
    if (from === target && i < at) at--; // the list got shorter in front of the target spot
  }
  const list = (out.order[target] ||= []);
  list.splice(Math.max(0, Math.min(at, list.length)), 0, ref);
  return out;
}

/** Put `ref` right after `afterRef` (used for duplicates), or at the top of `fallback`. */
export function placeAfter(lib, ref, afterRef, fallback = ROOT) {
  const cid = parentOf(lib, afterRef);
  if (cid === null) return move(lib, ref, fallback, 0);
  return move(lib, ref, cid, lib.order[cid].indexOf(afterRef) + 1);
}

export function addFolder(lib, name, parent = ROOT, index = 0) {
  const id = newFolderId();
  const out = clone(lib);
  out.folders[id] = { name: String(name).slice(0, 120), created: Date.now() };
  out.order[id] = [];
  return { lib: move(out, fref(id), out.folders[parent] ? parent : ROOT, index), id };
}

export function renameFolder(lib, id, name) {
  const out = clone(lib);
  out.folders[id] = { ...out.folders[id], name: String(name).slice(0, 120) };
  return out;
}

/** Delete a folder; whatever was inside moves up to where the folder was. */
export function deleteFolder(lib, id) {
  const out = clone(lib);
  const parent = parentOf(out, fref(id)) ?? ROOT;
  const list = out.order[parent];
  const i = list.indexOf(fref(id));
  list.splice(i < 0 ? list.length : i, i < 0 ? 0 : 1, ...(out.order[id] || []));
  delete out.order[id];
  delete out.folders[id];
  return out;
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
const COMPARE = {
  name: byName,
  modified: (a, b) => b.updated - a.updated, // newest first
  length: (a, b) => b.duration - a.duration, // longest first
};

/** Length of a project (its latest save) in seconds. */
export const projectLength = p => +p.saves?.[0]?.duration || 0;

/**
 * The tree to show: [{ ref, kind, id, name, project?, children?, count, updated, duration }].
 * `sort` is one of SORTS; `invert` flips it. With any sort but custom order, folders stay on top.
 * A folder's "last modified" is its newest project, its length the sum of its projects.
 */
export function buildTree(lib, projects, sort = 'order', invert = false) {
  const byId = new Map(projects.map(p => [p.id, p]));
  const build = cid => {
    const nodes = (lib.order[cid] || []).map((ref, index) => {
      const { kind, id } = parseRef(ref);
      if (kind === 'project') {
        const p = byId.get(id);
        return p && { ref, kind, id, index, name: p.name, project: p, count: 1, updated: p.updated || 0, duration: projectLength(p) };
      }
      const children = build(id);
      const sum = (k, f) => children.reduce((t, c) => f(t, c[k]), 0);
      return {
        ref, kind, id, index, name: lib.folders[id]?.name ?? 'Folder', children,
        count: sum('count', (a, b) => a + b),
        updated: Math.max(lib.folders[id]?.created || 0, sum('updated', Math.max)),
        duration: sum('duration', (a, b) => a + b),
      };
    }).filter(Boolean);
    if (sort === 'order' || !COMPARE[sort]) return invert ? nodes.reverse() : nodes;
    const dir = invert ? -1 : 1;
    return nodes.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1)
      || dir * COMPARE[sort](a, b) || byName(a, b) || a.index - b.index);
  };
  return build(ROOT);
}

/** Depth-first list of visible rows ({ node, depth }), skipping the inside of collapsed folders. */
export function flatten(tree, collapsed = new Set(), depth = 0, out = []) {
  for (const node of tree) {
    out.push({ node, depth });
    if (node.kind === 'folder' && !collapsed.has(node.id)) flatten(node.children, collapsed, depth + 1, out);
  }
  return out;
}
