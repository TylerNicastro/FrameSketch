// Moving projects between devices.
// A project (every save, drawings and audio included) is packed into one gzip-compressed JSON
// file, "<name>.fsk". It can be shared (phone share sheet: AirDrop, Messages, Drive, Discord…),
// downloaded, or turned into text ("FSK1:" + base64) to paste anywhere. Import accepts all of
// these, plus the older uncompressed .framesketch.json backups.

export const FORMAT = 'framesketch-project';
const TEXT_PREFIX = 'FSK1:';

const canGzip = () => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

async function gzip(bytes) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}
async function gunzip(bytes) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

export function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Collect a project with all its saves (oldest first) from the storage api. */
export async function collectProject(api, p, onProgress) {
  const saves = [];
  const list = [...p.saves].sort((a, b) => (a.updated || 0) - (b.updated || 0));
  for (let i = 0; i < list.length; i++) {
    onProgress?.(i, list.length);
    const s = list[i];
    const full = await api.getSave(p.id, s.id);
    saves.push({ name: s.name, created: s.created, updated: s.updated, doc: full.doc });
  }
  return { format: FORMAT, version: 1, exported: Date.now(), name: p.name, width: p.width, height: p.height, background: p.background, saves };
}

/** Pack to bytes (gzip when the browser can, plain JSON otherwise). */
export async function pack(data) {
  const json = new TextEncoder().encode(JSON.stringify(data));
  return canGzip() ? gzip(json) : json;
}

export const toText = bytes => TEXT_PREFIX + bytesToBase64(bytes);

/** Read a project from a File/Blob, bytes or pasted text. Throws a friendly error if it isn't one. */
export async function unpack(input) {
  let bytes;
  if (typeof input === 'string') {
    const t = input.trim();
    if (t.startsWith('{')) bytes = new TextEncoder().encode(t);
    else {
      const b64 = (t.startsWith(TEXT_PREFIX) ? t.slice(TEXT_PREFIX.length) : t).replace(/\s+/g, '');
      try { bytes = base64ToBytes(b64); } catch { throw new Error('That text is not a FrameSketch project.'); }
    }
  } else if (input instanceof Uint8Array) bytes = input;
  else bytes = new Uint8Array(await input.arrayBuffer());
  // a .txt holding the text form
  if (typeof input !== 'string' && String.fromCharCode(...bytes.subarray(0, 5)) === TEXT_PREFIX) {
    return unpack(new TextDecoder().decode(bytes));
  }

  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (!canGzip()) throw new Error('This browser cannot read compressed projects. Try an up-to-date browser.');
    try { bytes = await gunzip(bytes); } catch { throw new Error('The project file is damaged or incomplete.'); }
  }
  let data;
  try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error('That is not a FrameSketch project (or it was cut off while copying).'); }
  if (data?.format !== FORMAT || !Array.isArray(data.saves) || !data.saves.length) throw new Error('That is not a FrameSketch project.');
  return data;
}

/** Store an unpacked project as a new project. Returns the project summary. */
export async function importProject(api, data) {
  const saves = [...data.saves].sort((a, b) => (a.updated || 0) - (b.updated || 0)); // newest ends up on top
  const p = await api.createProject(data.name || 'Imported project', saves[0].doc);
  await api.renameSave(p.id, p.saves[0].id, saves[0].name || 'Save 1');
  for (const s of saves.slice(1)) await api.createSave(p.id, s.name || 'Save', s.doc);
  return api.getProject(p.id);
}

export const fileName = name => `${(name || 'project').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)}.fsk`;
