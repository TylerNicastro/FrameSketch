// Project storage. Two backends with the same interface:
//  - "server": the local Python server (server.py) keeps projects as files under data/.
//  - "local":  no server (GitHub Pages, phones): projects live in this browser's IndexedDB.
// The backend is picked once on startup by checking whether the server answers.

// ---------------------------------------------------------------- server
async function req(method, url, body) {
  const res = await fetch('api' + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error((data && data.error) || `${res.status} ${res.statusText}`);
  return data;
}

const serverApi = {
  listProjects: () => req('GET', '/projects'),
  getProject: pid => req('GET', `/projects/${pid}`),
  createProject: (name, doc) =>
    req('POST', '/projects', { name, doc, width: doc.width, height: doc.height, background: doc.background }),
  renameProject: (pid, name) => req('PATCH', `/projects/${pid}`, { name }),
  duplicateProject: pid => req('POST', `/projects/${pid}/duplicate`),
  deleteProject: pid => req('DELETE', `/projects/${pid}`),

  getSave: (pid, sid) => req('GET', `/projects/${pid}/saves/${sid}`),
  createSave: (pid, name, doc) => req('POST', `/projects/${pid}/saves`, { name, doc }),
  writeSave: (pid, sid, doc) => req('PUT', `/projects/${pid}/saves/${sid}`, { doc }),
  renameSave: (pid, sid, name) => req('PATCH', `/projects/${pid}/saves/${sid}`, { name }),
  duplicateSave: (pid, sid) => req('POST', `/projects/${pid}/saves/${sid}/duplicate`),
  deleteSave: (pid, sid) => req('DELETE', `/projects/${pid}/saves/${sid}`),

  /** Folders and custom order for the home screen (see library.js). */
  getLibrary: () => req('GET', '/library'),
  setLibrary: lib => req('PUT', '/library', lib),

  /** Save a file under data/exports and put it on the OS clipboard (server only). */
  async copyFile(name, blob) {
    const r = await fetch('api/export?name=' + encodeURIComponent(name), { method: 'POST', body: blob });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    if (!data.copied) throw new Error(data.error || 'the clipboard was not available');
    return data;
  },
};

// ---------------------------------------------------------------- browser (IndexedDB)
const DB_NAME = 'framesketch';
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 2);
      r.onupgradeneeded = e => {
        const d = r.result;
        if (e.oldVersion < 1) {
          d.createObjectStore('projects', { keyPath: 'id' });
          d.createObjectStore('saves', { keyPath: 'id' }).createIndex('pid', 'pid');
        }
        if (e.oldVersion < 2) d.createObjectStore('meta'); // 'library': folders + custom order
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error || new Error('This browser blocked storage (private mode?)'));
    });
  }
  return dbPromise;
}

const done = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

async function tx(stores, mode, fn) {
  const t = (await db()).transaction(stores, mode);
  const finished = new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage is full. Delete old saves or download a backup.'));
  });
  let out;
  try {
    out = await fn(...stores.map(s => t.objectStore(s)));
  } catch (e) {
    finished.catch(() => {});
    try { t.abort(); } catch { /* already finished */ }
    throw e;
  }
  await finished;
  return out;
}

const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');
/** Length of an animation in seconds (sum of frame times). */
export const docDuration = doc => Math.round((doc?.frames || []).reduce((t, f) => t + (+f.duration || 0), 0) * 1000) / 1000;
const metaOf = s => ({ id: s.id, name: s.name, created: s.created, updated: s.updated, frames: s.frames, duration: s.duration ?? docDuration(s.doc) });
const notFound = what => new Error(`${what} not found`);

async function summary(ps, ss, pid) {
  const p = await done(ps.get(pid));
  if (!p) throw notFound('project');
  const saves = (await done(ss.index('pid').getAll(pid))).map(metaOf).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  return { ...p, saves };
}

function putSave(ss, pid, sid, name, doc, created) {
  const t = Date.now();
  const s = { id: sid, pid, name, created: created || t, updated: t, frames: doc?.frames?.length || 0, duration: docDuration(doc), doc };
  ss.put(s);
  return s;
}

async function touchProject(ps, pid) {
  const p = await done(ps.get(pid));
  if (p) { p.updated = Date.now(); ps.put(p); }
}

const localApi = {
  async listProjects() {
    return tx(['projects', 'saves'], 'readonly', async (ps, ss) => {
      const all = await done(ps.getAll());
      const out = [];
      for (const p of all) out.push(await summary(ps, ss, p.id));
      return out.sort((a, b) => (b.updated || 0) - (a.updated || 0));
    });
  },
  getProject: pid => tx(['projects', 'saves'], 'readonly', (ps, ss) => summary(ps, ss, pid)),
  async createProject(name, doc) {
    const pid = newId(), t = Date.now();
    await tx(['projects', 'saves'], 'readwrite', (ps, ss) => {
      ps.put({ id: pid, name: String(name || 'Untitled project').slice(0, 120), created: t, updated: t, width: doc.width, height: doc.height, background: doc.background });
      putSave(ss, pid, newId(), 'Save 1', doc);
    });
    return this.getProject(pid);
  },
  async renameProject(pid, name) {
    await tx(['projects'], 'readwrite', async ps => {
      const p = await done(ps.get(pid));
      if (!p) throw notFound('project');
      Object.assign(p, { name: String(name).slice(0, 120), updated: Date.now() });
      ps.put(p);
    });
    return this.getProject(pid);
  },
  async duplicateProject(pid) {
    const nid = newId();
    await tx(['projects', 'saves'], 'readwrite', async (ps, ss) => {
      const p = await done(ps.get(pid));
      if (!p) throw notFound('project');
      const t = Date.now();
      ps.put({ ...p, id: nid, name: p.name + ' (copy)', created: t, updated: t });
      for (const s of await done(ss.index('pid').getAll(pid))) ss.put({ ...s, id: newId(), pid: nid });
    });
    return this.getProject(nid);
  },
  async deleteProject(pid) {
    await tx(['projects', 'saves'], 'readwrite', async (ps, ss) => {
      for (const k of await done(ss.index('pid').getAllKeys(pid))) ss.delete(k);
      ps.delete(pid);
    });
  },

  async getSave(pid, sid) {
    const s = await tx(['saves'], 'readonly', ss => done(ss.get(sid)));
    if (!s || s.pid !== pid) throw notFound('save');
    return s;
  },
  createSave: (pid, name, doc) => tx(['projects', 'saves'], 'readwrite', async (ps, ss) => {
    if (!await done(ps.get(pid))) throw notFound('project');
    const s = putSave(ss, pid, newId(), String(name || 'Save').slice(0, 120), doc);
    await touchProject(ps, pid);
    return metaOf(s);
  }),
  writeSave: (pid, sid, doc) => tx(['projects', 'saves'], 'readwrite', async (ps, ss) => {
    const old = await done(ss.get(sid));
    if (!old || old.pid !== pid) throw notFound('save');
    const s = putSave(ss, pid, sid, old.name, doc, old.created);
    await touchProject(ps, pid);
    return metaOf(s);
  }),
  renameSave: (pid, sid, name) => tx(['projects', 'saves'], 'readwrite', async (ps, ss) => {
    const s = await done(ss.get(sid));
    if (!s || s.pid !== pid) throw notFound('save');
    Object.assign(s, { name: String(name).slice(0, 120), updated: Date.now() });
    ss.put(s);
    await touchProject(ps, pid);
    return metaOf(s);
  }),
  duplicateSave: (pid, sid) => tx(['projects', 'saves'], 'readwrite', async (ps, ss) => {
    const s = await done(ss.get(sid));
    if (!s || s.pid !== pid) throw notFound('save');
    const c = putSave(ss, pid, newId(), s.name + ' (copy)', s.doc);
    await touchProject(ps, pid);
    return metaOf(c);
  }),
  deleteSave: (pid, sid) => tx(['projects', 'saves'], 'readwrite', async (ps, ss) => {
    ss.delete(sid);
    await touchProject(ps, pid);
  }),
  getLibrary: () => tx(['meta'], 'readonly', m => done(m.get('library'))).then(l => l || {}),
  setLibrary: lib => tx(['meta'], 'readwrite', m => { m.put(lib, 'library'); }),
  copyFile: null,
};

// ---------------------------------------------------------------- pick one
/** Is the FrameSketch server behind this page? (No on GitHub Pages or a plain static host.) */
async function hasServer() {
  if (location.protocol === 'file:') return false;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    const r = await fetch('api/projects', { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(t);
    return r.ok && (r.headers.get('content-type') || '').includes('application/json') && Array.isArray(await r.json());
  } catch {
    return false;
  }
}

export const api = {
  mode: null, // 'server' | 'local'
  async init() {
    const server = await hasServer();
    this.mode = server ? 'server' : 'local';
    Object.assign(this, server ? serverApi : localApi);
    if (!server) navigator.storage?.persist?.().catch(() => {}); // ask the browser not to evict our data
    return this.mode;
  },
};
