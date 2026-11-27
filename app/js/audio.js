// Audio: microphone recording, WAV (de)serialisation, playback and a waveform editor.
// A frame's audio is { samples: Float32Array (mono), rate: number, gain: number }.
// Sample arrays are treated as immutable: every edit makes a new array, so undo can
// simply keep a reference to the previous object.

import { clamp } from './util.js';

const TARGET_RATE = 24000; // microphone recordings
const IMPORT_RATE = 44100; // imported files (often music)
let ctx = null;

export function audioCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export const duration = a => (a ? a.samples.length / a.rate : 0);

// ---------------- recording ----------------
export class MicRecorder {
  constructor() {
    this.stream = null;
    this.rec = null;
    this.chunks = [];
    this.startedAt = 0;
  }

  get recording() { return !!this.rec && this.rec.state === 'recording'; }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone access is not available in this browser.');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream);
    this.rec.ondataavailable = e => e.data.size && this.chunks.push(e.data);
    this.rec.start(100);
    this.startedAt = performance.now();
  }

  elapsed() { return this.recording ? (performance.now() - this.startedAt) / 1000 : 0; }

  stop() {
    return new Promise((resolve, reject) => {
      if (!this.rec) return resolve(null);
      this.rec.onstop = async () => {
        this.stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(this.chunks, { type: this.rec.mimeType });
        this.rec = null;
        try {
          resolve(await blobToClip(blob));
        } catch (e) {
          reject(e);
        }
      };
      this.rec.stop();
    });
  }

  cancel() {
    if (!this.rec) return;
    this.rec.onstop = () => this.stream.getTracks().forEach(t => t.stop());
    this.rec.stop();
    this.rec = null;
  }
}

/** Decode an audio file (mp3, wav, ogg, m4a…) into a mono clip. Music keeps a higher rate than voice. */
export async function fileToClip(file) {
  try {
    return await blobToClip(file, IMPORT_RATE);
  } catch {
    throw new Error(`"${file.name || 'audio'}" isn't an audio format this browser can decode.`);
  }
}

async function blobToClip(blob, rate = TARGET_RATE) {
  const buf = await audioCtx().decodeAudioData(await blob.arrayBuffer());
  // Downmix to mono and resample to keep saves small.
  const length = Math.max(1, Math.ceil(buf.duration * rate));
  const off = new OfflineAudioContext(1, length, rate);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  return { samples: new Float32Array(out.getChannelData(0)), rate, gain: 1 };
}

// ---------------- WAV ----------------
function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function encodeWav(samples, rate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = clamp(samples[i], -1, 1);
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

export function serializeAudio(a) {
  if (!a) return null;
  return { wav: bytesToBase64(encodeWav(a.samples, a.rate)), gain: a.gain };
}

export function deserializeAudio(o) {
  if (!o || !o.wav) return null;
  const bytes = base64ToBytes(o.wav);
  const v = new DataView(bytes.buffer);
  // Walk chunks to find fmt/data (our own writer, but be tolerant).
  let p = 12, rate = TARGET_RATE, dataOff = 44, dataLen = bytes.length - 44;
  while (p + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
    const len = v.getUint32(p + 4, true);
    if (id === 'fmt ') rate = v.getUint32(p + 12, true);
    if (id === 'data') { dataOff = p + 8; dataLen = Math.min(len, bytes.length - dataOff); break; }
    p += 8 + len + (len & 1);
  }
  const n = Math.floor(dataLen / 2);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = v.getInt16(dataOff + i * 2, true) / 0x8000;
  return { samples, rate, gain: o.gain ?? 1 };
}

// ---------------- edits (return new clips) ----------------
const idx = (a, t) => clamp(Math.round(t * a.rate), 0, a.samples.length);

export function keepRange(a, t0, t1) {
  return { ...a, samples: a.samples.slice(idx(a, t0), idx(a, t1)) };
}

export function cutRange(a, t0, t1) {
  const i0 = idx(a, t0), i1 = idx(a, t1);
  const out = new Float32Array(a.samples.length - (i1 - i0));
  out.set(a.samples.subarray(0, i0), 0);
  out.set(a.samples.subarray(i1), i0);
  return { ...a, samples: out };
}

export function silenceRange(a, t0, t1) {
  const out = a.samples.slice();
  out.fill(0, idx(a, t0), idx(a, t1));
  return { ...a, samples: out };
}

export function normalize(a) {
  let peak = 0;
  for (const s of a.samples) peak = Math.max(peak, Math.abs(s));
  if (peak < 1e-5) return a;
  const k = 0.98 / peak;
  return { ...a, samples: a.samples.map(s => s * k), gain: 1 };
}

// ---------------- peaks (for drawing long clips quickly) ----------------
const PEAK_RATE = 200; // buckets per second
const peakCache = new WeakMap();

/** Max-abs peaks of a clip at PEAK_RATE buckets per second (cached per sample array). */
export function clipPeaks(a) {
  let p = peakCache.get(a.samples);
  if (p) return p;
  const per = Math.max(1, Math.round(a.rate / PEAK_RATE));
  const n = Math.ceil(a.samples.length / per);
  const peaks = new Float32Array(n);
  const s = a.samples;
  for (let b = 0; b < n; b++) {
    let m = 0;
    for (let i = b * per, e = Math.min(s.length, i + per); i < e; i++) { const v = s[i] < 0 ? -s[i] : s[i]; if (v > m) m = v; }
    peaks[b] = m;
  }
  p = { peaks, bps: a.rate / per };
  peakCache.set(a.samples, p);
  return p;
}

// ---------------- playback ----------------
const bufCache = new WeakMap();
function bufferFor(a) {
  let buf = bufCache.get(a.samples);
  if (!buf) {
    buf = audioCtx().createBuffer(1, a.samples.length, a.rate);
    buf.copyToChannel(a.samples, 0);
    bufCache.set(a.samples, buf);
  }
  return buf;
}

/**
 * Schedule part of a clip on the audio clock: start at context time `when`, `offset` seconds into
 * the clip, for `dur` seconds, routed into `dest`. Returns the source node.
 */
export function scheduleClip(a, when, offset, dur, dest, rate = 1) {
  if (!a || !a.samples.length || dur <= 0) return null;
  const c = audioCtx();
  const src = c.createBufferSource();
  src.buffer = bufferFor(a);
  src.playbackRate.value = rate; // offset / dur are clip seconds; `when` is real (clock) time
  const g = c.createGain();
  g.gain.value = a.gain;
  src.connect(g).connect(dest || c.destination);
  const late = Math.max(0, c.currentTime - when) * rate; // in clip seconds
  if (late >= dur) return null;
  src.start(when + late / rate, offset + late, dur - late);
  return src;
}

export function playClip(a, from = 0, to = null, onEnd = null) {
  if (!a || !a.samples.length) return null;
  const c = audioCtx();
  const buf = bufferFor(a);
  const src = c.createBufferSource();
  src.buffer = buf;
  const g = c.createGain();
  g.gain.value = a.gain;
  src.connect(g).connect(c.destination);
  const end = to == null ? buf.duration : Math.min(to, buf.duration);
  const startAt = c.currentTime;
  src.start(0, from, Math.max(0, end - from));
  const handle = {
    stop() { try { src.stop(); } catch { /* already stopped */ } },
    position: () => from + (c.currentTime - startAt),
    ended: false,
  };
  src.onended = () => { handle.ended = true; onEnd && onEnd(); };
  return handle;
}

// ---------------- waveform editor ----------------
export class WaveEditor {
  constructor(canvas, onChange) {
    this.canvas = canvas;
    this.onChange = onChange;
    this.audio = null;
    this.frameDur = 0;
    this.sel = null; // [t0, t1] seconds
    this.cursor = null; // a single clicked point (seconds), e.g. where to split
    this.snaps = []; // seconds into the clip (frame edges) that a clicked point snaps to
    this.playhead = null;
    this.live = null; // live recording seconds
    this.peaks = null;
    this.drag = null;

    canvas.addEventListener('pointerdown', e => this.down(e));
    canvas.addEventListener('pointermove', e => this.move(e));
    canvas.addEventListener('pointerup', e => this.up(e));
    canvas.addEventListener('dblclick', () => { this.sel = null; this.cursor = null; this.draw(); this.onChange?.(); });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  set(audio, frameDur) {
    if (audio !== this.audio) {
      this.audio = audio;
      this.peaks = null;
      if (this.sel && (!audio || this.sel[1] > duration(audio))) this.sel = null;
      if (this.cursor != null && (!audio || this.cursor >= duration(audio))) this.cursor = null;
    }
    this.frameDur = frameDur;
    this.draw();
  }

  clearSelection() { this.sel = null; this.cursor = null; this.draw(); }

  viewSeconds() {
    return Math.max(duration(this.audio), this.frameDur, this.live || 0, 0.5);
  }

  timeAt(e) {
    const r = this.canvas.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1) * this.viewSeconds();
  }

  down(e) {
    if (!this.audio) return;
    this.canvas.setPointerCapture(e.pointerId);
    const t = Math.min(this.timeAt(e), duration(this.audio));
    // Grab a selection edge if close.
    if (this.sel) {
      const px = this.viewSeconds() / this.canvas.clientWidth * 6;
      if (Math.abs(t - this.sel[0]) < px) { this.drag = { edge: 0 }; return; }
      if (Math.abs(t - this.sel[1]) < px) { this.drag = { edge: 1 }; return; }
    }
    this.drag = { anchor: t };
    this.sel = [t, t];
    this.cursor = null;
    this.draw();
  }

  move(e) {
    if (!this.drag || !this.audio) return;
    const t = Math.min(this.timeAt(e), duration(this.audio));
    if (this.drag.edge != null) {
      this.sel[this.drag.edge] = t;
      if (this.sel[0] > this.sel[1]) { this.sel.reverse(); this.drag.edge ^= 1; }
    } else {
      this.sel = [Math.min(this.drag.anchor, t), Math.max(this.drag.anchor, t)];
    }
    this.draw();
  }

  up() {
    if (!this.drag) return;
    const anchor = this.drag.anchor;
    this.drag = null;
    if (this.sel && this.sel[1] - this.sel[0] < 0.01) {
      this.sel = null;
      if (anchor != null) this.cursor = this.snap(anchor); // a plain click marks a point
    }
    this.draw();
    this.onChange?.();
  }

  /** Snap `t` to a frame edge within 6px. */
  snap(t) {
    const tol = this.viewSeconds() / Math.max(1, this.canvas.clientWidth) * 6;
    let best = tol, out = t;
    for (const s of this.snaps) if (Math.abs(s - t) < best && s > 0) { best = Math.abs(s - t); out = s; }
    return out;
  }

  computePeaks(w) {
    const s = this.audio.samples;
    const per = this.audio.rate * this.viewSeconds() / w; // samples per pixel
    const peaks = [];
    const total = Math.ceil(s.length / Math.max(per, 1e-9));
    for (let x = 0; x < Math.min(total, w); x++) {
      let lo = 0, hi = 0;
      const a = Math.floor(x * per), b = Math.min(s.length, Math.floor((x + 1) * per) + 1);
      for (let i = a; i < b; i++) { const v = s[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      peaks.push([lo, hi]);
    }
    return peaks;
  }

  draw() {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; this.peaks = null; }
    const g = c.getContext('2d');
    g.clearRect(0, 0, w, h);
    const view = this.viewSeconds();
    const X = t => (t / view) * w;

    // seconds grid
    g.fillStyle = 'rgba(255,255,255,0.06)';
    g.font = `${10 * dpr}px system-ui`;
    for (let t = 0; t <= view; t += view > 20 ? 5 : 1) {
      g.fillRect(X(t), 0, 1, h);
      g.fillStyle = 'rgba(255,255,255,0.3)';
      g.fillText(t + 's', X(t) + 3 * dpr, 11 * dpr);
      g.fillStyle = 'rgba(255,255,255,0.06)';
    }

    // frame length marker
    if (this.frameDur) {
      g.fillStyle = 'rgba(240,180,41,0.08)';
      g.fillRect(X(this.frameDur), 0, w - X(this.frameDur), h);
      g.fillStyle = '#f0b429';
      g.fillRect(X(this.frameDur), 0, Math.max(1, dpr), h);
    }

    if (this.audio) {
      const key = w + '|' + view;
      if (!this.peaks || this.peaksKey !== key) { this.peaks = this.computePeaks(w); this.peaksKey = key; }
      const mid = h / 2;
      const gain = this.audio.gain;
      g.fillStyle = '#5b8cff';
      this.peaks.forEach(([lo, hi], x) => {
        const y0 = mid - clamp(hi * gain, -1, 1) * mid * 0.92;
        const y1 = mid - clamp(lo * gain, -1, 1) * mid * 0.92;
        g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
      });
    }

    if (this.live != null) {
      g.fillStyle = 'rgba(255,77,94,0.25)';
      g.fillRect(0, 0, X(this.live), h);
    }

    if (this.sel) {
      g.fillStyle = 'rgba(255,255,255,0.14)';
      g.fillRect(X(this.sel[0]), 0, X(this.sel[1]) - X(this.sel[0]), h);
      g.fillStyle = '#fff';
      g.fillRect(X(this.sel[0]), 0, dpr, h);
      g.fillRect(X(this.sel[1]) - dpr, 0, dpr, h);
    }

    if (this.cursor != null) {
      g.fillStyle = this.snaps.includes(this.cursor) ? '#f0b429' : '#fff';
      for (let y = 0; y < h; y += 6 * dpr) g.fillRect(X(this.cursor), y, Math.max(1, dpr), 3 * dpr);
    }

    if (this.playhead != null) {
      g.fillStyle = '#ff4d5e';
      g.fillRect(X(this.playhead), 0, 2 * dpr, h);
    }
  }
}
