// Multi-track audio arrangement view: one lane per track, clips drawn across the whole
// timeline with frame boundaries behind them. The editor (host) owns the data; this class
// only draws a model it asks for and reports clicks / drags back.
//
// host.trackModel() -> { frames: [{start, dur}], total, maxEnd, cur, selClipId, selTrackId,
//                        tracks: [{ id, color, muted, spans: [{ clip, start, end, natEnd }] }] }
// host.onSeek(t), host.onSelectTrack(id), host.onSelectClip(trackId, clipId),
// host.onMoveClip(clipId, startSeconds, trackId), host.onMoveClipEnd(),
// host.onSplitClip(clipId, secondsIntoClip)  (click a clip in split mode, or Alt+click),
// host.splitMode  (true while the Split button is waiting for a click)

import { clamp } from './util.js';
import { clipPeaks, duration } from './audio.js';

export const RULER = 18;
export const LANE = 34;
const MIN_PPS = 30; // below this many pixels per second the view scrolls instead of shrinking
const SNAP_PX = 8; // clip starts and split points snap to frame edges this close
const COLORS = ['#5b8cff', '#3fb68b', '#e08a3c', '#b36be0', '#e0607e', '#3cb7c8'];
export const trackColor = i => COLORS[i % COLORS.length];

const alpha = (hex, a) => hex + Math.round(clamp(a, 0, 1) * 255).toString(16).padStart(2, '0');

export class TrackView {
  constructor(canvas, scroller, host) {
    this.canvas = canvas;
    this.scroller = scroller;
    this.host = host;
    this.playhead = null;
    this.drag = null;
    canvas.addEventListener('pointerdown', e => this.down(e));
    canvas.addEventListener('pointermove', e => this.move(e));
    canvas.addEventListener('pointerup', e => this.up(e));
    canvas.addEventListener('pointercancel', e => this.up(e));
    canvas.addEventListener('pointerleave', () => this.setHover(null));
    new ResizeObserver(() => this.draw()).observe(scroller);
  }

  layout() {
    const m = this.host.trackModel();
    const view = Math.max(m.total, m.maxEnd, 0.5) * 1.02;
    const avail = Math.max(50, this.scroller.clientWidth);
    const pps = Math.max(avail / view, MIN_PPS);
    return { m, pps, width: Math.max(avail, Math.ceil(view * pps)), height: RULER + Math.max(1, m.tracks.length) * LANE };
  }

  /** Scroll horizontally so timeline second `t` is visible. */
  reveal(t0, t1) {
    const L = this.L || this.layout();
    const s = this.scroller, x0 = t0 * L.pps, x1 = t1 * L.pps;
    if (x0 < s.scrollLeft) s.scrollLeft = x0 - 20;
    else if (x1 > s.scrollLeft + s.clientWidth) s.scrollLeft = Math.min(x0 - 20, x1 - s.clientWidth + 20);
  }

  draw() {
    if (!this.scroller.isConnected || this.scroller.offsetParent === null) return; // hidden
    const L = this.layout();
    this.L = L;
    const { m, pps } = L;
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    c.style.width = L.width + 'px';
    c.style.height = L.height + 'px';
    const w = Math.round(L.width * dpr), h = Math.round(L.height * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, L.width, L.height);
    const X = t => t * pps;

    // frame bands + numbers
    g.font = '10px system-ui, sans-serif';
    m.frames.forEach((f, i) => {
      const x0 = X(f.start), x1 = X(f.start + f.dur);
      if (i === m.cur) { g.fillStyle = 'rgba(91,140,255,0.16)'; g.fillRect(x0, 0, x1 - x0, L.height); }
      else if (i % 2) { g.fillStyle = 'rgba(255,255,255,0.025)'; g.fillRect(x0, 0, x1 - x0, L.height); }
      g.fillStyle = 'rgba(255,255,255,0.13)';
      g.fillRect(Math.round(x0), 0, 1, L.height);
      if (x1 - x0 > 12) {
        g.fillStyle = i === m.cur ? '#fff' : 'rgba(255,255,255,0.45)';
        g.fillText(String(i + 1), x0 + 3, 12);
      }
    });
    // past the end of the animation (nothing plays there)
    g.fillStyle = 'rgba(0,0,0,0.4)';
    g.fillRect(X(m.total), 0, L.width - X(m.total), L.height);
    g.fillStyle = 'rgba(255,255,255,0.13)';
    g.fillRect(0, RULER - 1, L.width, 1);

    m.tracks.forEach((t, li) => {
      const y = RULER + li * LANE;
      if (t.id === m.selTrackId) { g.fillStyle = 'rgba(255,255,255,0.05)'; g.fillRect(0, y, L.width, LANE); }
      g.fillStyle = 'rgba(255,255,255,0.07)';
      g.fillRect(0, y + LANE - 1, L.width, 1);
      for (const s of t.spans) this.drawClip(g, s, y, t, pps, s.clip.id === m.selClipId);
    });
    if (!m.tracks.length) {
      g.fillStyle = 'rgba(255,255,255,0.4)';
      g.fillText('No audio tracks — press + Track, Record, or Import audio.', 8, RULER + 20);
    }

    if (this.playhead != null) {
      g.fillStyle = '#ff4d5e';
      g.fillRect(X(this.playhead) - 1, 0, 2, L.height);
    }

    // where a click would split (dashed; yellow when snapped to a frame edge)
    const hv = this.hover;
    if (hv) {
      const y = RULER + hv.lane * LANE;
      g.fillStyle = hv.snapped ? '#f0b429' : '#fff';
      for (let yy = y + 1; yy < y + LANE - 1; yy += 5) g.fillRect(Math.round(X(hv.t)) - 1, yy, 2, 3);
    }
  }

  /** Split point under the pointer, snapped to the nearest frame start/end within SNAP_PX. */
  splitPoint(hit) {
    const L = this.L;
    let t = hit.t, best = SNAP_PX / L.pps, snapped = false;
    for (const f of L.m.frames) {
      for (const b of [f.start, f.start + f.dur]) {
        const d = Math.abs(b - hit.t);
        if (d < best && b > hit.span.start && b < hit.span.natEnd) { best = d; t = b; snapped = true; }
      }
    }
    return { t, snapped };
  }

  setHover(h) {
    const a = this.hover;
    if (a === h || (a && h && a.t === h.t && a.lane === h.lane && a.snapped === h.snapped)) return;
    this.hover = h;
    this.draw();
  }

  drawClip(g, s, y, t, pps, selected) {
    const x0 = s.start * pps, xe = s.end * pps, x1 = s.natEnd * pps;
    const top = y + 3, hh = LANE - 6, mid = top + hh / 2;
    g.save();
    g.globalAlpha = t.muted ? 0.35 : 1;
    g.fillStyle = alpha(t.color, 0.3);
    g.fillRect(x0, top, Math.max(1, xe - x0), hh);
    if (x1 > xe) { // part that is cut off (by the next clip, frame end or animation end)
      g.fillStyle = 'rgba(255,255,255,0.05)';
      g.fillRect(xe, top, x1 - xe, hh);
    }
    const { peaks, bps } = clipPeaks(s.clip.audio);
    const gain = s.clip.audio.gain;
    for (let px = Math.floor(x0); px < x1; px++) {
      const b0 = Math.max(0, Math.floor((px - x0) / pps * bps));
      const b1 = Math.min(peaks.length, Math.max(b0 + 1, Math.ceil((px + 1 - x0) / pps * bps)));
      let p = 0;
      for (let b = b0; b < b1; b++) if (peaks[b] > p) p = peaks[b];
      const a = Math.min(1, p * gain) * (hh / 2 - 1);
      g.fillStyle = px < xe ? t.color : 'rgba(255,255,255,0.22)';
      g.fillRect(px, mid - a, 1, Math.max(1, a * 2));
    }
    g.lineWidth = selected ? 2 : 1;
    g.strokeStyle = selected ? '#fff' : alpha(t.color, 0.9);
    g.strokeRect(x0 + 0.5, top + 0.5, Math.max(1, x1 - x0 - 1), hh - 1);
    if (xe - x0 > 36) {
      g.fillStyle = '#fff';
      g.font = '10px system-ui, sans-serif';
      g.fillText(duration(s.clip.audio).toFixed(1) + 's', x0 + 4, top + 11);
    }
    g.restore();
  }

  pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  spanAt(x, y) {
    const L = this.L;
    if (!L || y < RULER) return null;
    const tr = L.m.tracks[Math.floor((y - RULER) / LANE)];
    if (!tr) return null;
    const t = x / L.pps;
    const span = [...tr.spans].reverse().find(s => t >= s.start && t <= s.natEnd);
    return { tr, span, t };
  }

  down(e) {
    if (e.button !== 0 || !this.L) return;
    const { x, y } = this.pos(e);
    this.canvas.setPointerCapture(e.pointerId);
    if (y < RULER) { this.drag = { seek: true }; this.host.onSeek(x / this.L.pps); return; }
    const hit = this.spanAt(x, y);
    if (!hit) return;
    if (hit.span && (e.altKey || this.host.splitMode)) {
      const { t } = this.splitPoint(hit);
      this.hover = null;
      this.host.onSplitClip(hit.span.clip.id, t - hit.span.start);
      return;
    }
    if (hit.span) {
      this.host.onSelectClip(hit.tr.id, hit.span.clip.id);
      this.drag = { clipId: hit.span.clip.id, grab: hit.t - hit.span.start, sx: x, sy: y, moved: false };
    } else {
      this.host.onSelectTrack(hit.tr.id);
      this.host.onSeek(hit.t);
    }
  }

  move(e) {
    const L = this.L;
    if (!L) return;
    const { x, y } = this.pos(e);
    const d = this.drag;
    if (!d) {
      const hit = this.spanAt(x, y);
      const splitting = hit?.span && (e.altKey || this.host.splitMode);
      this.canvas.style.cursor = hit?.span ? (splitting ? 'col-resize' : 'grab') : 'default';
      this.setHover(splitting ? { ...this.splitPoint(hit), lane: L.m.tracks.indexOf(hit.tr) } : null);
      return;
    }
    if (d.seek) { this.host.onSeek(x / L.pps); return; }
    if (!d.moved && Math.hypot(x - d.sx, y - d.sy) < 4) return;
    d.moved = true;
    this.canvas.style.cursor = 'grabbing';
    let start = Math.max(0, x / L.pps - d.grab);
    for (const f of L.m.frames) { // snap to frame starts
      if (Math.abs(f.start - start) * L.pps < SNAP_PX) { start = f.start; break; }
    }
    const tr = L.m.tracks[clamp(Math.floor((y - RULER) / LANE), 0, L.m.tracks.length - 1)];
    this.host.onMoveClip(d.clipId, start, tr.id);
  }

  up() {
    if (this.drag?.moved) this.host.onMoveClipEnd();
    this.drag = null;
    this.canvas.style.cursor = 'default';
  }
}
