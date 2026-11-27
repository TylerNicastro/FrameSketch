// Video export, with all audio tracks.
// Fast path (WebCodecs): each drawing is encoded once and held for its duration, the audio is
// mixed offline, and the result is written as an MP4 by mp4.js. This takes seconds, not the
// scene's length. Fallback: play the scene into a canvas and record it in real time (MediaRecorder).

import { makeCanvas, clamp } from './util.js';
import * as A from './audio.js';
import { muxMp4, avcEntry, aacEntry, opusEntry } from './mp4.js';

// MP4 (H.264 + AAC) embeds everywhere, Discord's mobile apps included; WebM is the fallback.
const TYPES = [
  'video/mp4;codecs=avc1.42E01F,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export const videoSupported = () => typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;

/**
 * Make a video of the editor's scene. Returns { blob, ext, type, fast } (null if cancelled).
 * `onProgress(seconds, total)` reports progress; `signal.cancelled = true` stops early.
 */
export async function recordVideo(ed, opts = {}) {
  let fast = null;
  try {
    fast = await encodeFast(ed, opts);
  } catch (e) {
    console.warn('Fast video export unavailable, recording in real time instead:', e);
  }
  if (fast || opts.signal?.cancelled) return fast && { ...fast, fast: true };
  opts.onFallback?.();
  const slow = await recordRealtime(ed, opts);
  return slow && { ...slow, fast: false };
}

const H264 = ['avc1.42E01F', 'avc1.42E028', 'avc1.4D0028', 'avc1.640028', 'avc1.42E033', 'avc1.640033'];

async function pickConfig(list, base, Enc) {
  for (const codec of list) {
    const config = { ...base, codec };
    try {
      if ((await Enc.isConfigSupported(config)).supported) return config;
    } catch { /* try the next one */ }
  }
  return null;
}

const copyBytes = d => new Uint8Array(ArrayBuffer.isView(d) ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d.slice(0));
const tick = () => new Promise(r => setTimeout(r, 0));

/** Mix every unmuted track to a stereo AudioBuffer, faster than real time. */
async function mixAudio(ed, timing, rate) {
  const len = Math.max(1, Math.ceil(timing.total * rate));
  const oc = new OfflineAudioContext(2, len, rate);
  for (const t of ed.tracks) {
    if (t.muted) continue;
    const g = oc.createGain();
    g.gain.value = t.volume;
    g.connect(oc.destination);
    for (const s of ed.trackSpans(t, timing)) {
      const a = s.clip.audio;
      if (!a?.samples.length || s.end <= s.start) continue;
      const buf = oc.createBuffer(1, a.samples.length, a.rate);
      buf.copyToChannel(a.samples, 0);
      const src = oc.createBufferSource();
      src.buffer = buf;
      const cg = oc.createGain();
      cg.gain.value = a.gain;
      src.connect(cg).connect(g);
      src.start(s.start, 0, s.end - s.start);
    }
  }
  return oc.startRendering();
}

async function encodeFast(ed, { onProgress, signal = {}, targetBytes = 9e6 } = {}) {
  if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined') throw new Error('no WebCodecs');
  const k = Math.min(1, 1920 / Math.max(ed.W, ed.H));
  const w = Math.max(2, Math.round(ed.W * k / 2) * 2), h = Math.max(2, Math.round(ed.H * k / 2) * 2);
  const timing = ed.timing();
  const total = timing.total;
  if (!(total > 0)) throw new Error('empty scene');

  // Each drawing is encoded once (a keyframe), repeated every <= 0.5 s so players can seek.
  const STEP = 0.5;
  const shots = [];
  ed.frames.forEach((f, i) => {
    const n = Math.max(1, Math.ceil(f.duration / STEP - 1e-9));
    for (let j = 0; j < n; j++) shots.push({ i, t: timing.starts.get(f.id) + (f.duration * j) / n, key: j === 0 });
  });

  const rate = 48000, audioBps = 128000;
  const videoBps = Math.round(clamp((targetBytes * 8) / total - audioBps, 300000, 12000000));
  const vconf = await pickConfig(H264, {
    width: w, height: h, bitrate: videoBps, framerate: Math.max(1, shots.length / total),
    avc: { format: 'avc' }, latencyMode: 'quality',
  }, VideoEncoder);
  if (!vconf) throw new Error('no H.264 encoder');
  let aconf = await pickConfig(['mp4a.40.2'], { sampleRate: rate, numberOfChannels: 2, bitrate: audioBps }, AudioEncoder);
  const opus = !aconf;
  if (opus) aconf = await pickConfig(['opus'], { sampleRate: rate, numberOfChannels: 2, bitrate: audioBps }, AudioEncoder);
  if (!aconf) throw new Error('no AAC / Opus encoder');

  // ---- video ----
  const vSamples = [];
  let avcC = null, vErr = null;
  const ve = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig?.description && !avcC) avcC = copyBytes(meta.decoderConfig.description);
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      vSamples.push({ data, key: chunk.type === 'key', ts: chunk.timestamp });
    },
    error: e => { vErr = e; },
  });
  ve.configure(vconf);
  const canvas = makeCanvas(w, h);
  const g = canvas.getContext('2d');
  const frameCanvas = makeCanvas(ed.W, ed.H);
  const fg = frameCanvas.getContext('2d');
  let shown = -1;
  for (let n = 0; n < shots.length; n++) {
    if (signal.cancelled) { ve.close(); return null; }
    if (vErr) throw vErr;
    const s = shots[n];
    if (s.i !== shown) {
      fg.clearRect(0, 0, ed.W, ed.H);
      ed.composite(fg, ed.frames[s.i]);
      g.clearRect(0, 0, w, h);
      g.drawImage(frameCanvas, 0, 0, w, h);
      shown = s.i;
    }
    const next = n + 1 < shots.length ? shots[n + 1].t : total;
    const vf = new VideoFrame(canvas, { timestamp: Math.round(s.t * 1e6), duration: Math.round((next - s.t) * 1e6) });
    ve.encode(vf, { keyFrame: s.key || n === 0 });
    vf.close();
    while (ve.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 1)); // keep memory bounded
    if (n % 5 === 0) { onProgress?.(s.t * 0.8, total); await tick(); }
  }
  await ve.flush();
  ve.close();
  if (vErr) throw vErr;
  if (!avcC || !vSamples.length) throw new Error('video encoder gave no output');

  // ---- audio ----
  onProgress?.(total * 0.85, total);
  const mixed = await mixAudio(ed, timing, rate);
  if (signal.cancelled) return null;
  const aSamples = [];
  let aDesc = null, aErr = null;
  const ae = new AudioEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig?.description && !aDesc) aDesc = copyBytes(meta.decoderConfig.description);
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      aSamples.push({ data, dur: chunk.duration });
    },
    error: e => { aErr = e; },
  });
  ae.configure(aconf);
  const L = mixed.getChannelData(0), R = mixed.getChannelData(1);
  const BLOCK = 4800;
  for (let i = 0; i < L.length; i += BLOCK) {
    const n = Math.min(BLOCK, L.length - i);
    const data = new Float32Array(n * 2);
    data.set(L.subarray(i, i + n), 0);
    data.set(R.subarray(i, i + n), n);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((i / rate) * 1e6), data });
    ae.encode(ad);
    ad.close();
  }
  await ae.flush();
  ae.close();
  if (aErr) throw aErr;
  if (!opus && !aDesc) aDesc = aacConfig(rate, 2);
  onProgress?.(total, total);

  // ---- mux ----
  const durMs = Math.round(total * 1000);
  const vTimes = vSamples.map(s => Math.round(s.ts / 1000)); // ms; deltas of rounded times add up exactly
  const video = {
    kind: 'video', timescale: 1000, width: w, height: h, stsd: avcEntry(w, h, avcC),
    samples: vSamples.map((s, i) => ({ data: s.data, key: s.key, duration: Math.max(1, (i + 1 < vTimes.length ? vTimes[i + 1] : durMs) - vTimes[i]) })),
  };
  const frameLen = opus ? 960 : 1024;
  const audio = {
    kind: 'audio', timescale: rate, stsd: opus ? opusEntry(2, rate, aDesc) : aacEntry(2, rate, aDesc),
    samples: aSamples.map(s => ({ data: s.data, duration: (s.dur && Math.round((s.dur * rate) / 1e6)) || frameLen })),
  };
  return { blob: muxMp4([video, audio], durMs), type: 'video/mp4', ext: 'mp4' };
}

/** AudioSpecificConfig for AAC-LC, in case the encoder doesn't provide one. */
function aacConfig(rate, channels) {
  const idx = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000].indexOf(rate);
  return Uint8Array.of((2 << 3) | (idx >> 1), ((idx & 1) << 7) | (channels << 3));
}

/** Real-time fallback: play the scene into a canvas and record it with MediaRecorder. */
async function recordRealtime(ed, { onProgress, signal = {}, targetBytes = 9e6 } = {}) {
  if (!videoSupported()) throw new Error('This browser cannot record video (try Chrome or Edge).');
  const type = TYPES.find(t => MediaRecorder.isTypeSupported(t));
  if (!type) throw new Error('This browser cannot record video.');

  // size: keep the long edge at most 1920 and both sides even (H.264 needs that)
  const k = Math.min(1, 1920 / Math.max(ed.W, ed.H));
  const w = Math.max(2, Math.round(ed.W * k / 2) * 2), h = Math.max(2, Math.round(ed.H * k / 2) * 2);
  const out = makeCanvas(w, h);
  const og = out.getContext('2d');
  const frameCanvas = makeCanvas(ed.W, ed.H);
  const fg = frameCanvas.getContext('2d');

  const timing = ed.timing();
  const total = timing.total;
  const starts = ed.frames.map(f => timing.starts.get(f.id));
  const indexAt = t => { let i = 0; while (i + 1 < starts.length && starts[i + 1] <= t) i++; return i; };
  let shown = -1;
  const paint = i => {
    if (i !== shown) {
      fg.clearRect(0, 0, ed.W, ed.H);
      ed.composite(fg, ed.frames[i]);
      shown = i;
    }
    og.drawImage(frameCanvas, 0, 0, w, h);
  };
  paint(0);

  // audio: every unmuted track into a stream destination (silent on the speakers)
  const ac = A.audioCtx();
  await ac.resume?.();
  const dest = ac.createMediaStreamDestination();
  const gains = [], sources = [];
  for (const t of ed.tracks) {
    if (t.muted) continue;
    const g = ac.createGain();
    g.gain.value = t.volume;
    g.connect(dest);
    gains.push({ t, g });
  }

  const stream = new MediaStream([...out.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  // aim below Discord's 10 MB upload limit
  const vbps = Math.round(clamp((targetBytes * 8) / Math.max(total, 0.5) - 128000, 250000, 8000000));
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: vbps, audioBitsPerSecond: 128000 });
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const stopped = new Promise(r => (rec.onstop = r));
  rec.start(250);

  const at = ac.currentTime + 0.15;
  for (const { t, g } of gains) {
    for (const s of ed.trackSpans(t, timing)) {
      const src = A.scheduleClip(s.clip.audio, at + s.start, 0, s.end - s.start, g);
      if (src) sources.push(src);
    }
  }

  // a timer, not requestAnimationFrame, so a hidden tab keeps going (at a lower frame rate)
  await new Promise(resolve => {
    const timer = setInterval(() => {
      const t = ac.currentTime - at;
      if (signal.cancelled || t >= total + 0.1) { clearInterval(timer); resolve(); return; }
      paint(indexAt(clamp(t, 0, Math.max(0, total - 1e-6))));
      onProgress?.(clamp(t, 0, total), total);
    }, 1000 / 30);
  });

  rec.stop();
  await stopped;
  for (const s of sources) { try { s.stop(); } catch { /* already ended */ } }
  for (const { g } of gains) g.disconnect();
  stream.getTracks().forEach(tr => tr.stop());
  if (signal.cancelled) return null;
  const blob = new Blob(chunks, { type: type.split(';')[0] });
  return { blob, type: blob.type, ext: blob.type === 'video/mp4' ? 'mp4' : 'webm' };
}
