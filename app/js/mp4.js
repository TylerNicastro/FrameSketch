// Minimal MP4 (ISO BMFF) writer for one H.264 video track and one AAC or Opus audio track.
// The file is "fast start": moov comes before mdat, one sample per chunk, no fragments.

const enc = new TextEncoder();

class Buf {
  constructor() { this.parts = []; this.length = 0; }
  push(u8) { this.parts.push(u8); this.length += u8.length; }
  u8(v) { this.push(Uint8Array.of(v & 255)); }
  u16(v) { this.push(Uint8Array.of((v >>> 8) & 255, v & 255)); }
  u24(v) { this.push(Uint8Array.of((v >>> 16) & 255, (v >>> 8) & 255, v & 255)); }
  u32(v) { this.push(Uint8Array.of((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255)); }
  str(s) { this.push(enc.encode(s)); }
  zeros(n) { this.push(new Uint8Array(n)); }
  bytes() {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

function box(type, ...children) {
  const b = new Buf();
  const body = children.map(c => (c instanceof Uint8Array ? c : c.bytes()));
  const size = 8 + body.reduce((n, c) => n + c.length, 0);
  b.u32(size);
  b.str(type);
  for (const c of body) b.push(c);
  return b.bytes();
}

function fullBox(type, version, flags, fill, ...children) {
  const b = new Buf();
  b.u8(version);
  b.u24(flags);
  fill?.(b);
  return box(type, b.bytes(), ...children);
}

const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
const writeMatrix = b => MATRIX.forEach(v => b.u32(v));

function sttsOf(durations) {
  const runs = [];
  for (const d of durations) {
    const last = runs[runs.length - 1];
    if (last && last[1] === d) last[0]++;
    else runs.push([1, d]);
  }
  return fullBox('stts', 0, 0, b => { b.u32(runs.length); for (const [n, d] of runs) { b.u32(n); b.u32(d); } });
}

function stbl(t, offsets) {
  const kids = [
    t.stsd,
    sttsOf(t.samples.map(s => s.duration)),
  ];
  if (t.kind === 'video') {
    const keys = t.samples.map((s, i) => (s.key ? i + 1 : 0)).filter(Boolean);
    kids.push(fullBox('stss', 0, 0, b => { b.u32(keys.length); keys.forEach(k => b.u32(k)); }));
  }
  kids.push(
    fullBox('stsc', 0, 0, b => { b.u32(1); b.u32(1); b.u32(1); b.u32(1); }),
    fullBox('stsz', 0, 0, b => { b.u32(0); b.u32(t.samples.length); t.samples.forEach(s => b.u32(s.data.length)); }),
    fullBox('stco', 0, 0, b => { b.u32(offsets.length); offsets.forEach(o => b.u32(o)); }),
  );
  return box('stbl', ...kids);
}

function trak(t, id, movieDurMs, offsets) {
  const dur = t.samples.reduce((n, s) => n + s.duration, 0);
  const video = t.kind === 'video';
  const tkhd = fullBox('tkhd', 0, 3, b => {
    b.u32(0); b.u32(0); b.u32(id); b.u32(0); b.u32(movieDurMs);
    b.zeros(8); b.u16(0); b.u16(0); b.u16(video ? 0 : 0x0100); b.u16(0);
    writeMatrix(b);
    b.u32(video ? t.width << 16 : 0); b.u32(video ? t.height << 16 : 0);
  });
  const mdhd = fullBox('mdhd', 0, 0, b => { b.u32(0); b.u32(0); b.u32(t.timescale); b.u32(dur); b.u16(0x55c4); b.u16(0); });
  const hdlr = fullBox('hdlr', 0, 0, b => {
    b.u32(0); b.str(video ? 'vide' : 'soun'); b.zeros(12); b.str(video ? 'VideoHandler' : 'SoundHandler'); b.u8(0);
  });
  const mhd = video
    ? fullBox('vmhd', 0, 1, b => { b.u16(0); b.u16(0); b.u16(0); b.u16(0); })
    : fullBox('smhd', 0, 0, b => { b.u16(0); b.u16(0); });
  const dinf = box('dinf', fullBox('dref', 0, 0, b => b.u32(1), fullBox('url ', 0, 1)));
  return box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', mhd, dinf, stbl(t, offsets))));
}

/** avc1 sample entry; `avcC` is the AVCDecoderConfigurationRecord (VideoEncoder's description). */
export function avcEntry(width, height, avcC) {
  const b = new Buf();
  b.zeros(6); b.u16(1); // reserved, data_reference_index
  b.u16(0); b.u16(0); b.zeros(12);
  b.u16(width); b.u16(height);
  b.u32(0x00480000); b.u32(0x00480000); b.u32(0); b.u16(1);
  b.zeros(32); b.u16(0x0018); b.u16(0xffff);
  return fullBox('stsd', 0, 0, x => x.u32(1), box('avc1', b.bytes(), box('avcC', avcC)));
}

function audioEntryHead(channels, rate) {
  const b = new Buf();
  b.zeros(6); b.u16(1);
  b.zeros(8); b.u16(channels); b.u16(16); b.u16(0); b.u16(0);
  b.u32((rate & 0xffff) << 16 >>> 0); // 16.16 fixed point (48000 and 44100 fit)
  return b.bytes();
}

/** mp4a sample entry; `asc` is the AAC AudioSpecificConfig (AudioEncoder's description). */
export function aacEntry(channels, rate, asc) {
  const desc = (tag, body) => { const b = new Buf(); b.u8(tag); b.u8(body.length); b.push(body); return b.bytes(); };
  const dsi = desc(0x05, asc);
  const dcd = new Buf();
  dcd.u8(0x40); dcd.u8(0x15); dcd.u24(0); dcd.u32(128000); dcd.u32(128000); dcd.push(dsi);
  const es = new Buf();
  es.u16(0); es.u8(0); es.push(desc(0x04, dcd.bytes())); es.push(desc(0x06, Uint8Array.of(2)));
  const esds = fullBox('esds', 0, 0, null, desc(0x03, es.bytes()));
  return fullBox('stsd', 0, 0, x => x.u32(1), box('mp4a', audioEntryHead(channels, rate), esds));
}

/** Opus sample entry; `head` is the OpusHead (little endian) that AudioEncoder gives. */
export function opusEntry(channels, rate, head) {
  const dv = head && head.length >= 19 ? new DataView(head.buffer, head.byteOffset, head.byteLength) : null;
  const preSkip = dv ? dv.getUint16(10, true) : 312;
  const b = new Buf();
  b.u8(0); b.u8(channels); b.u16(preSkip); b.u32(48000); b.u16(0); b.u8(0);
  return fullBox('stsd', 0, 0, x => x.u32(1), box('Opus', audioEntryHead(channels, rate), box('dOps', b.bytes())));
}

/**
 * tracks: [{ kind: 'video'|'audio', timescale, width?, height?, stsd, samples: [{ data, duration, key? }] }]
 * Returns a Blob (video/mp4).
 */
export function muxMp4(tracks, durationMs) {
  const ftyp = box('ftyp', (() => { const b = new Buf(); b.str('isom'); b.u32(0x200); b.str('isomiso2avc1mp41'); return b; })());
  const moovFor = offsets => box('moov',
    fullBox('mvhd', 0, 0, b => {
      b.u32(0); b.u32(0); b.u32(1000); b.u32(durationMs); b.u32(0x00010000); b.u16(0x0100);
      b.zeros(10); writeMatrix(b); b.zeros(24); b.u32(tracks.length + 1);
    }),
    ...tracks.map((t, i) => trak(t, i + 1, durationMs, offsets[i])),
  );
  // offsets don't change the moov size, so measure it with zeros first
  const zero = tracks.map(t => t.samples.map(() => 0));
  const moovSize = moovFor(zero).length;
  let pos = ftyp.length + moovSize + 8; // + mdat header
  const offsets = tracks.map(t => t.samples.map(s => { const o = pos; pos += s.data.length; return o; }));
  const moov = moovFor(offsets);
  const mdatSize = pos - ftyp.length - moovSize;
  const head = new Buf();
  head.u32(mdatSize); head.str('mdat');
  const parts = [ftyp, moov, head.bytes()];
  for (const t of tracks) for (const s of t.samples) parts.push(s.data);
  return new Blob(parts, { type: 'video/mp4' });
}
