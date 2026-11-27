async function req(method, url, body) {
  const res = await fetch('/api' + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error((data && data.error) || `${res.status} ${res.statusText}`);
  return data;
}

export const api = {
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
};
