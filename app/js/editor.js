// The drawing / animation editor.
import {
  $, $$, el, uid, clamp, makeCanvas, hexToRgba, rgbToHex, loadImage,
  toast, modal, sheet, confirmModal, promptModal, isModalOpen,
} from './util.js';
import * as A from './audio.js';
import { TrackView, trackColor } from './tracks.js';
import { api } from './api.js';
import { recordVideo } from './video.js';

const PALETTE = [
  '#000000', '#3b3b3b', '#7a7a7a', '#bdbdbd', '#ffffff', '#5c3a21', '#a0522d', '#e0a96d', '#f5deb3', '#ffe0bd',
  '#e53935', '#fb8c00', '#fdd835', '#7cb342', '#2e7d32', '#00acc1', '#1e88e5', '#3949ab', '#8e24aa', '#d81b60',
];

// `anchor` pins a caption to a spot on the frame ('top' | 'middle' | 'bottom'), horizontally
// centered (or at the left/right margin for left/right alignment). null = free position (x, y).
const CAPTION_STYLE = {
  size: 36, font: 'system-ui, sans-serif', color: '#ffffff', outline: '#000000',
  box: '#000000', boxAlpha: 0, align: 'center', bold: true, anchor: 'bottom', margin: 40,
};
const STYLE_KEYS = Object.keys(CAPTION_STYLE);
const HANDLE_CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o[k]]));

const newTrack = name => ({ id: uid(), name, muted: false, volume: 1, clips: [] });
const cloneTracks = ts => ts.map(t => ({ ...t, clips: t.clips.map(c => ({ ...c })) }));

const UNDO_LIMIT = 30;
const TOOL_NAMES = {
  brush: 'Brush', eraser: 'Eraser', fill: 'Fill bucket', picker: 'Eyedropper',
  rect: 'Rectangle select', lasso: 'Lasso select', move: 'Move', caption: 'Caption',
};
const TOOL_KEYS = { b: 'brush', e: 'eraser', g: 'fill', i: 'picker', m: 'rect', l: 'lasso', v: 'move', t: 'caption' };

const ctx2d = c => c.getContext('2d');

/** A blank document in the saved (serialised) format. */
export function newDoc({ width = 1280, height = 720, background = '#ffffff' } = {}) {
  const l1 = { id: uid(), name: 'Layer 1', type: 'raster', visible: true, opacity: 1 };
  const cap = { id: uid(), name: 'Captions', type: 'caption', visible: true, opacity: 1 };
  return {
    version: 2, width, height, background,
    layers: [l1, cap],
    frames: [{ id: uid(), duration: 1, cels: { [l1.id]: null, [cap.id]: [] } }],
    tracks: [{ id: uid(), name: 'Voice', muted: false, volume: 1, clips: [] }],
  };
}

export class Editor {
  constructor({ onBack }) {
    this.onBack = onBack;
    this.view = $('#view');
    this.overlay = $('#overlay');
    this.scroll = $('#stageScroll');
    this.wave = new A.WaveEditor($('#wave'), () => this.onWaveChange());
    this.splitMode = false;
    this.trackView = new TrackView($('#tracksCanvas'), $('#trackScroll'), this);
    this.mic = new A.MicRecorder();
    this.measure = ctx2d(makeCanvas(1, 1));

    this.tool = 'brush';
    this.color = '#222222';
    this.recent = [];
    // brush and eraser keep their own size / opacity
    this.toolSettings = { brush: { size: 8, opacity: 1 }, eraser: { size: 30, opacity: 1 } };
    this.smoothing = 0.3;
    this.tracks = [];
    this.zoom = 1;
    this.ants = 0;
    this.capStyle = { ...CAPTION_STYLE };
    this.frames = [];
    this.layers = [];
    this.undoStack = [];
    this.redoStack = [];

    this.bindUI();
    setInterval(() => {
      if (this.selection || this.action?.sel) { this.ants = (this.ants + 1) % 8; this.renderOverlay(); }
    }, 120);
  }

  // =====================================================================
  // open / load / save
  // =====================================================================
  async open(project, saveMeta) {
    const save = await api.getSave(project.id, saveMeta.id);
    this.project = project;
    this.saveMeta = saveMeta;
    await this.load(save.doc);
    $('#projName').textContent = project.name;
    $('#saveName').textContent = saveMeta.name;
    this.setDirty(false);
    $('#home').hidden = true;
    $('#editor').hidden = false;
    this.renderAll();
    this.updateVideoButton();
    requestAnimationFrame(() => this.fit());
  }

  close() {
    clearTimeout(this.autoTimer);
    this.stop();
    this.stopPreview();
    if (this.mic.recording) { this.mic.cancel(); this.endRecordingUI(); }
    $('#editor').hidden = true;
    this.selection = null;
    this.floating = null;
    this.frames = [];
    this.tracks = [];
    this.undoStack = [];
    this.redoStack = [];
  }

  async load(doc) {
    this.W = doc.width;
    this.H = doc.height;
    this.background = doc.background || '#ffffff';
    this.layers = doc.layers.map(l => ({ ...l }));
    const saved = doc.captionStyle || {};
    this.capStyle = { ...CAPTION_STYLE, ...pick(saved, STYLE_KEYS.filter(k => k in saved)) };
    const legacyAudio = []; // version 1 saves stored one clip per frame
    this.frames = await Promise.all(doc.frames.map(async f => {
      const fr = { id: f.id || uid(), duration: f.duration || 1, cels: {}, cache: {} };
      if (f.audio) legacyAudio.push({ frameId: fr.id, audio: A.deserializeAudio(f.audio) });
      for (const l of this.layers) {
        const src = f.cels?.[l.id];
        if (l.type === 'raster') {
          const c = makeCanvas(this.W, this.H);
          if (src) {
            try { ctx2d(c).drawImage(await loadImage(src), 0, 0); fr.cache[l.id] = src; } catch { /* corrupt cel */ }
          }
          fr.cels[l.id] = c;
        } else {
          // captions saved before anchors existed keep their free position
          fr.cels[l.id] = (src || []).map(c => ({ ...CAPTION_STYLE, anchor: null, ...c }));
        }
      }
      return fr;
    }));

    const frameIds = new Set(this.frames.map(f => f.id));
    this.tracks = (doc.tracks || []).map(t => ({
      id: t.id || uid(), name: t.name || 'Track', muted: !!t.muted, volume: t.volume ?? 1,
      clips: (t.clips || [])
        .map(c => ({ id: c.id || uid(), frameId: c.frameId, offset: c.offset || 0, trim: !!c.trim, audio: A.deserializeAudio(c.audio) }))
        .filter(c => c.audio && frameIds.has(c.frameId)),
    }));
    if (legacyAudio.length) {
      const voice = newTrack('Voice');
      // keep the old behaviour exactly: each clip stopped at the end of its frame
      for (const { frameId, audio } of legacyAudio) if (audio) voice.clips.push({ id: uid(), frameId, offset: 0, trim: true, audio });
      this.tracks.unshift(voice);
    }
    if (!this.tracks.length) this.tracks.push(newTrack('Voice'));
    this.selTrackId = this.tracks[0].id;
    this.selClipId = null;
    this.lastRasterId = null;

    this.cur = 0;
    this.activeId = (this.layers.find(l => l.type === 'raster') || this.layers[0]).id;
    this.selection = null;
    this.floating = null;
    this.clipboard = null;
    this.extraLayers = new Set(); // extra layers selected with Ctrl/Shift+click (for copying several)
    this.touches = new Map(); // active touch points on the canvas (pinch / two-finger pan)
    this.gesture = null;
    this.selCaption = null;
    this.undoStack = [];
    this.redoStack = [];
    this.action = null;
    this.stroke = null;

    this.view.width = this.W;
    this.view.height = this.H;
    this.strokeBuf = makeCanvas(this.W, this.H);
    this.tmp = makeCanvas(this.W, this.H);
  }

  serialize() {
    this.commitFloating();
    return {
      version: 2,
      width: this.W, height: this.H, background: this.background,
      captionStyle: pick(this.capStyle, STYLE_KEYS),
      tracks: this.tracks.map(t => ({
        id: t.id, name: t.name, muted: t.muted, volume: t.volume,
        clips: t.clips.filter(c => this.frameById(c.frameId)).map(c => ({ id: c.id, frameId: c.frameId, offset: c.offset, trim: c.trim, audio: A.serializeAudio(c.audio) })),
      })),
      layers: this.layers.map(({ id, name, type, visible, opacity }) => ({ id, name, type, visible, opacity })),
      frames: this.frames.map(f => {
        const cels = {};
        for (const l of this.layers) {
          if (l.type === 'raster') {
            if (!f.cache[l.id]) f.cache[l.id] = f.cels[l.id].toDataURL('image/png');
            cels[l.id] = f.cache[l.id];
          } else {
            cels[l.id] = f.cels[l.id];
          }
        }
        return { id: f.id, duration: f.duration, cels };
      }),
    };
  }

  async save({ quiet = false } = {}) {
    if (this.saving || !this.project) return;
    this.saving = true;
    const seq = this.changeSeq;
    this.showSaveState('saving');
    try {
      const meta = await api.writeSave(this.project.id, this.saveMeta.id, this.serialize());
      this.saveMeta = meta;
      // only clean if nothing changed while the save was being written
      if (this.changeSeq === seq) this.setDirty(false);
      else this.scheduleAutoSave();
      this.showSaveState(this.dirty ? 'unsaved' : 'saved');
      if (!quiet) toast('Saved');
    } catch (e) {
      this.showSaveState('unsaved');
      toast('Save failed: ' + e.message, true);
    } finally {
      this.saving = false;
    }
  }

  get autoSaveOn() { return $('#chkAutoSave').checked; }

  /** Save a few seconds after the last change (when auto-save is on). */
  scheduleAutoSave(delay = 3000) {
    clearTimeout(this.autoTimer);
    if (!this.autoSaveOn || !this.project) return;
    this.autoTimer = setTimeout(() => this.autoSave(), delay);
  }

  async autoSave() {
    if (!this.dirty || !this.autoSaveOn || !this.project || $('#editor').hidden) return;
    // wait for a quiet moment: not mid-stroke, mid-move, playing, recording or exporting
    if (this.saving || this.action || this.stroke || this.floating || this.playing || this.mic.recording || this.videoJob) {
      this.scheduleAutoSave(2000);
      return;
    }
    await this.save({ quiet: true });
  }

  showSaveState(state) {
    const s = $('#saveState');
    s.textContent = { saving: 'Saving…', saved: 'Saved', unsaved: this.autoSaveOn ? 'Unsaved' : 'Unsaved' }[state] || '';
    s.className = 'save-state ' + state;
    clearTimeout(this.saveStateTimer);
    if (state === 'saved') this.saveStateTimer = setTimeout(() => { if (!this.dirty) s.textContent = ''; }, 2500);
  }

  async saveAs() {
    const proj = await api.getProject(this.project.id).catch(() => null);
    const n = (proj?.saves?.length || 0) + 1;
    const name = await promptModal('Save as new', 'Name for the new save', `Save ${n}`);
    if (!name) return;
    try {
      this.saveMeta = await api.createSave(this.project.id, name, this.serialize());
      $('#saveName').textContent = this.saveMeta.name;
      this.setDirty(false);
      toast(`Saved as "${name}"`);
    } catch (e) {
      toast('Save failed: ' + e.message, true);
    }
  }

  setDirty(v) {
    if (v) { this.changeSeq = (this.changeSeq || 0) + 1; this.scheduleAutoSave(); }
    if (v && !this.dirty) this.showSaveState('unsaved');
    this.dirty = v;
    $('#dirtyMark').hidden = !v;
  }

  /** Mark a cel as changed: invalidates its saved PNG, sets dirty, refreshes its thumbnail. */
  touch(frame, layerId) {
    if (layerId) delete frame.cache[layerId];
    this.setDirty(true);
    this.scheduleThumb(frame);
  }

  // =====================================================================
  // getters
  // =====================================================================
  get frame() { return this.frames?.[this.cur]; }
  get layer() { return this.layers.find(l => l.id === this.activeId); }
  layerById(id) { return this.layers.find(l => l.id === id); }
  frameById(id) { return this.frames.find(f => f.id === id); }

  /** Size / opacity of the brush or eraser, whichever is in use (a pen's eraser tip counts as the eraser). */
  get brushSet() { return this.toolSettings[this.stroke?.eraser || (!this.stroke && this.tool === 'eraser') ? 'eraser' : 'brush']; }
  get size() { return this.brushSet.size; }
  set size(v) { this.brushSet.size = v; }
  get opacity() { return this.brushSet.opacity; }
  set opacity(v) { this.brushSet.opacity = v; }

  // =====================================================================
  // rendering
  // =====================================================================
  renderAll() {
    this.renderLayers();
    this.renderTimeline();
    this.refreshFrameUI();
    this.renderTrackHeads();
    this.refreshAudio(true);
    this.setTool(this.tool);
    this.setColor(this.color, false);
    this.renderCaptionPanel();
    this.refreshQuickCaption();
    this.render();
  }

  requestRender() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
  }

  render() {
    if (!this.frames?.length) return;
    const g = ctx2d(this.view);
    g.clearRect(0, 0, this.W, this.H);
    const onion = $('#chkOnion').checked && this.cur > 0 && !this.playing ? this.frames[this.cur - 1] : null;
    this.composite(g, this.frame, { live: true, onion });
    this.renderOverlay();
  }

  /** The canvas to draw for a raster layer, including any in-progress stroke or floating selection. */
  liveLayer(frame, layer) {
    const cel = frame.cels[layer.id];
    const stroking = this.stroke && layer.id === this.activeId && frame === this.frame;
    const floating = this.floating && this.floating.layerId === layer.id && this.floating.frameId === frame.id;
    if (!stroking && !floating) return cel;
    const t = ctx2d(this.tmp);
    t.clearRect(0, 0, this.W, this.H);
    t.drawImage(cel, 0, 0);
    if (stroking) this.applyStroke(t);
    if (floating) t.drawImage(this.floating.canvas, this.floating.dx, this.floating.dy);
    return this.tmp;
  }

  composite(g, frame, { background = true, live = false, onion = null, layersOnly = false } = {}) {
    g.save();
    if (background && this.background !== 'transparent') {
      g.fillStyle = this.background;
      g.fillRect(0, 0, this.W, this.H);
    }
    if (onion) {
      for (const l of this.layers) {
        if (l.type !== 'raster' || !l.visible) continue;
        g.globalAlpha = 0.3 * l.opacity;
        g.drawImage(onion.cels[l.id], 0, 0);
      }
    }
    for (const l of this.layers) {
      if (!l.visible) continue;
      g.globalAlpha = l.opacity;
      if (l.type === 'raster') g.drawImage(live ? this.liveLayer(frame, l) : frame.cels[l.id], 0, 0);
      else if (!layersOnly) this.drawCaptions(g, frame.cels[l.id], l.opacity);
    }
    g.restore();
  }

  // ---------------- captions ----------------
  captionFont(c) { return `${c.bold ? 'bold ' : ''}${c.size}px ${c.font}`; }

  captionLayout(c) {
    const m = this.measure;
    m.font = this.captionFont(c);
    const margin = c.margin ?? CAPTION_STYLE.margin;
    const pad = c.size * 0.25;
    // A free caption can have a resized box (boxW / boxH): text wraps to its width and is centered in it.
    const sized = !c.anchor && c.boxW > 0;
    const bw = sized ? Math.max(c.size + 2 * pad, c.boxW) : 0;
    const wrapW = sized ? bw - 2 * pad : Math.max(c.size, c.anchor ? this.W - 2 * margin : this.W * 0.95);
    const lines = wrapText(m, String(c.text), wrapW);
    const lh = c.size * 1.2;
    const w = Math.max(1, ...lines.map(s => m.measureText(s).width));
    const h = lines.length * lh;
    if (sized) {
      const bh = Math.max(h + 2 * pad, c.boxH || 0);
      const bx = c.align === 'center' ? c.x - bw / 2 : c.align === 'left' ? c.x - pad : c.x + pad - bw;
      const by = c.y - pad;
      const left = c.align === 'center' ? c.x - w / 2 : c.align === 'left' ? c.x : c.x - w;
      return { lines, lh, w, h, left, top: by + (bh - h) / 2, x: c.x, pad, box: { x: bx, y: by, w: bw, h: bh } };
    }
    const { x, y } = this.captionAnchorPos(c, h, c.anchor);
    const left = c.align === 'center' ? x - w / 2 : c.align === 'left' ? x : x - w;
    return { lines, lh, w, h, left, top: y, x, pad };
  }

  /** The caption's position handle (what x / y mean for a free caption). */
  captionOrigin(L) { return { x: L.x, y: L.box ? L.box.y + L.pad : L.top }; }

  /** Where the caption's text origin goes for a given anchor (null = its own x / y). */
  captionAnchorPos(c, h, anchor) {
    if (!anchor) return { x: c.x, y: c.y };
    const M = c.margin ?? CAPTION_STYLE.margin;
    const x = c.align === 'left' ? M : c.align === 'right' ? this.W - M : this.W / 2;
    const y = anchor === 'top' ? M : anchor === 'middle' ? (this.H - h) / 2 : this.H - M - h;
    return { x, y };
  }

  captionBounds(c, L = this.captionLayout(c)) {
    return L.box || { x: L.left - L.pad, y: L.top - L.pad, w: L.w + L.pad * 2, h: L.h + L.pad * 2 };
  }

  /** Resize handles of the selected caption's box (only free captions can be resized). */
  captionHandles(c) {
    if (!c || c.anchor) return [];
    const b = this.captionBounds(c);
    const xs = { w: b.x, c: b.x + b.w / 2, e: b.x + b.w }, ys = { n: b.y, m: b.y + b.h / 2, s: b.y + b.h };
    return ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(k => {
      const v = k.includes('n') ? 'n' : k.includes('s') ? 's' : 'm';
      const hz = k.includes('w') ? 'w' : k.includes('e') ? 'e' : 'c';
      return { k, x: xs[hz], y: ys[v] };
    });
  }

  captionHandleAt(p) {
    if (!['caption', 'move'].includes(this.tool) || this.playing) return null;
    const tol = 7 / this.zoom;
    return this.captionHandles(this.selectedCaption()).find(h => Math.abs(h.x - p.x) <= tol && Math.abs(h.y - p.y) <= tol) || null;
  }

  drawCaptions(g, caps, alpha = 1) {
    for (const c of caps) {
      const L = this.captionLayout(c);
      g.save();
      if (c.boxAlpha > 0) {
        const b = this.captionBounds(c, L);
        g.globalAlpha = alpha * c.boxAlpha;
        g.fillStyle = c.box;
        g.fillRect(b.x, b.y, b.w, b.h);
      }
      g.globalAlpha = alpha;
      g.font = this.captionFont(c);
      g.textAlign = c.align;
      g.textBaseline = 'top';
      g.lineJoin = 'round';
      L.lines.forEach((line, i) => {
        const y = L.top + i * L.lh + c.size * 0.1;
        if (c.outline && c.outline !== c.color) {
          g.strokeStyle = c.outline;
          g.lineWidth = Math.max(1, c.size * 0.14);
          g.strokeText(line, L.x, y);
        }
        g.fillStyle = c.color;
        g.fillText(line, L.x, y);
      });
      g.restore();
    }
  }

  // ---------------- overlay ----------------
  renderOverlay() {
    if (!this.W) return;
    const o = this.overlay;
    const g = ctx2d(o);
    const s = this.ovScale || 1;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, o.width, o.height);
    g.setTransform(s, 0, 0, s, 0, 0);
    const px = 1 / this.zoom; // one CSS pixel in document units

    const ants = (path, closed = true) => {
      g.lineWidth = px;
      g.setLineDash([4 * px, 4 * px]);
      g.strokeStyle = '#000';
      g.lineDashOffset = -this.ants * px;
      g.stroke(path);
      g.strokeStyle = '#fff';
      g.lineDashOffset = -this.ants * px + 4 * px;
      g.stroke(path);
      g.setLineDash([]);
    };

    if (this.selection) ants(this.selection.path);
    const a = this.action;
    if (a?.sel?.length > 1) ants(this.polyPath(a.sel, a.tool === 'rect'));

    // selected caption
    const sc = this.selectedCaption();
    if (sc && !this.playing) {
      const b = this.captionBounds(sc);
      g.lineWidth = 1.5 * px;
      g.setLineDash([5 * px, 3 * px]);
      g.strokeStyle = '#5b8cff';
      g.strokeRect(b.x, b.y, b.w, b.h);
      g.setLineDash([]);
      if (['caption', 'move'].includes(this.tool)) {
        const hs = 7 * px;
        for (const h of this.captionHandles(sc)) {
          g.fillStyle = '#fff';
          g.fillRect(h.x - hs / 2, h.y - hs / 2, hs, hs);
          g.lineWidth = px;
          g.strokeStyle = '#5b8cff';
          g.strokeRect(h.x - hs / 2, h.y - hs / 2, hs, hs);
        }
      }
    }

    // brush cursor
    if (this.hover && !this.playing && (this.tool === 'brush' || this.tool === 'eraser')) {
      const r = Math.max(0.5, this.size / 2);
      g.beginPath();
      g.arc(this.hover.x, this.hover.y, r, 0, Math.PI * 2);
      g.lineWidth = 2 * px; g.strokeStyle = 'rgba(0,0,0,.6)'; g.stroke();
      g.lineWidth = px; g.strokeStyle = 'rgba(255,255,255,.9)'; g.stroke();
    }
  }

  polyPath(pts, closed = true) {
    const p = new Path2D();
    pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
    if (closed) p.closePath();
    return p;
  }

  // =====================================================================
  // zoom
  // =====================================================================
  setZoom(z, anchor) {
    z = clamp(z, 0.05, 16);
    const old = this.zoom;
    let ax, ay;
    if (anchor) {
      const r = this.view.getBoundingClientRect();
      ax = (anchor.clientX - r.left) / old;
      ay = (anchor.clientY - r.top) / old;
    }
    this.zoom = z;
    const w = Math.round(this.W * z), h = Math.round(this.H * z);
    this.view.style.width = w + 'px';
    this.view.style.height = h + 'px';
    const dpr = window.devicePixelRatio || 1;
    this.ovScale = Math.min(z * dpr, 8192 / Math.max(this.W, this.H));
    this.overlay.width = Math.round(this.W * this.ovScale);
    this.overlay.height = Math.round(this.H * this.ovScale);
    this.overlay.style.width = w + 'px';
    this.overlay.style.height = h + 'px';
    this.scroll.classList.toggle('pixelated', z >= 2);
    $('#zoomLabel').textContent = Math.round(z * 100) + '%';
    if (anchor) {
      this.scroll.scrollLeft += ax * (z - old);
      this.scroll.scrollTop += ay * (z - old);
    }
    this.renderOverlay();
  }

  fit() {
    const r = this.scroll.getBoundingClientRect();
    this.setZoom(Math.min((r.width - 80) / this.W, (r.height - 80) / this.H));
  }

  zoomStep(dir, anchor) {
    const steps = [0.05, 0.1, 0.15, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16];
    const z = this.zoom;
    const next = dir > 0 ? steps.find(s => s > z + 1e-3) : [...steps].reverse().find(s => s < z - 1e-3);
    this.setZoom(next ?? z, anchor);
  }

  // =====================================================================
  // tools & color
  // =====================================================================
  setTool(t) {
    if (t !== this.tool) this.commitFloating();
    this.tool = t;
    $$('#toolbar button').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    $('#toolOptionsTitle').textContent = TOOL_NAMES[t];
    $$('#toolOptions .opt').forEach(o => (o.hidden = !o.dataset.for.split(' ').includes(t)));
    if (t === 'brush' || t === 'eraser') {
      const s = this.toolSettings[t];
      $('#sizeInput').value = s.size; $('#sizeOut').textContent = s.size;
      $('#opacityInput').value = Math.round(s.opacity * 100); $('#opacityOut').textContent = Math.round(s.opacity * 100) + '%';
    }
    this.scroll.style.cursor = this.toolCursor();
    this.syncQuickBar();
    this.renderOverlay();
  }

  setColor(hex, addRecent = false) {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) return;
    this.color = hex.toLowerCase();
    if (this.frames?.length) $('#qbColor').style.background = this.color;
    $('#colorInput').value = this.color;
    if (document.activeElement !== $('#hexInput')) $('#hexInput').value = this.color;
    if (addRecent) this.addRecent(this.color);
  }

  addRecent(hex) {
    this.recent = [hex, ...this.recent.filter(c => c !== hex)].slice(0, 10);
    const box = $('#recentSwatches');
    box.innerHTML = '';
    for (const c of this.recent) {
      box.append(el('button', { title: c, style: `background:${c}`, onclick: () => this.setColor(c) }));
    }
  }

  // =====================================================================
  // pointer input
  // =====================================================================
  pt(e) {
    const r = this.view.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (this.W / r.width), y: (e.clientY - r.top) * (this.H / r.height) };
  }

  pressure(e) {
    return e.pointerType === 'pen' && $('#pressureInput').checked ? Math.max(0.05, e.pressure || 0.5) : 1;
  }

  /**
   * Check the active layer can be painted on. If a caption layer is active (e.g. after using the
   * caption tool) switch back to the last drawing layer instead of refusing.
   */
  paintable() {
    let l = this.layer;
    if (!l) return false;
    if (l.type !== 'raster') {
      const back = this.layerById(this.lastRasterId);
      const target = back?.type === 'raster' ? back : [...this.layers].reverse().find(x => x.type === 'raster' && x.visible);
      if (!target) { toast('There is no drawing layer. Add one with + Layer.', true); return false; }
      this.setActiveLayer(target.id);
      l = target;
    }
    if (!l.visible) { toast(`"${l.name}" is hidden. Show it (👁) to draw on it.`, true); return false; }
    return true;
  }

  /** Painting is clipped to the selection; say so when a stroke starts outside it. */
  warnOutsideSelection(p) {
    if (!this.selection) return;
    if (!ctx2d(this.tmp).isPointInPath(this.selection.path, p.x, p.y)) {
      toast('Painting is limited to the selection. Press Ctrl+D to deselect.', true);
    }
  }

  onDown(e) {
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size >= 2) {
        if (!this.gesture) { this.cancelAction(); this.startGesture(); }
        this.gesture.fingers = Math.max(this.gesture.fingers, this.touches.size);
        return;
      }
    }
    if (e.pointerType === 'pen' && !this.penSeen) {
      this.penSeen = true;
      let pref = null;
      try { pref = localStorage.getItem('fs.fingerDraws'); } catch { /* storage blocked */ }
      if (pref === null && this.fingerDraws) {
        $('#fingerDrawInput').checked = false;
        toast('Pen detected: fingers now pan and zoom so your palm can rest on the screen. Change it under Brush → "Draw with finger".');
      }
    }
    if (this.playing || !this.frames?.length) return;
    if (e.target !== this.view && e.target !== this.scroll && e.target !== $('#stage')) return;
    // ignore clicks on the scrollbars
    if (e.target === this.scroll && (e.offsetX >= this.scroll.clientWidth || e.offsetY >= this.scroll.clientHeight)) return;
    if (e.button === 1 || (e.button === 0 && this.spaceHeld)) {
      e.preventDefault();
      this.action = { tool: 'pan', sx: e.clientX, sy: e.clientY, sl: this.scroll.scrollLeft, st: this.scroll.scrollTop };
      try { this.scroll.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      return;
    }
    // fingers pan instead of drawing when "Draw with finger" is off (pen users)
    if (e.pointerType === 'touch' && !this.fingerDraws) {
      this.action = { tool: 'pan', sx: e.clientX, sy: e.clientY, sl: this.scroll.scrollLeft, st: this.scroll.scrollTop };
      return;
    }
    // A pen's eraser end reports button 5 (buttons bit 32): erase whatever tool is selected.
    const penEraser = e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32));
    if (e.button !== 0 && !penEraser) return;
    const p = this.pt(e);
    let tool = penEraser ? 'eraser' : this.tool;
    if (e.altKey && ['brush', 'eraser', 'fill'].includes(tool)) tool = 'picker';
    try { this.scroll.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    this.action = { tool, start: p };

    switch (tool) {
      case 'brush':
      case 'eraser':
        if (!this.paintable()) { this.action = null; return; }
        this.warnOutsideSelection(p);
        this.startStroke(p, e, tool === 'eraser');
        break;
      case 'fill':
        if (e.pointerType === 'touch') { this.action = { tool: 'fill', start: p, pending: true }; break; }
        this.action = null;
        if (this.paintable()) this.fillAt(p);
        break;
      case 'picker':
        this.action = { tool };
        this.pickAt(p);
        break;
      case 'rect':
        this.commitFloating();
        this.action.sel = [[p.x, p.y]];
        break;
      case 'lasso':
        this.commitFloating();
        this.action.sel = [[p.x, p.y]];
        break;
      case 'move':
        if (this.layer.type === 'caption') { this.captionDown(p, false); break; }
        if (!this.paintable()) { this.action = null; return; }
        if (!this.floating) this.lift();
        this.action.origin = { dx: this.floating.dx, dy: this.floating.dy };
        this.action.selOrig = this.selection?.points.map(q => [...q]);
        break;
      case 'caption':
        this.captionDown(p, true);
        break;
    }
  }

  onMove(e) {
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.gesture) { if (this.touches.size >= 2) this.updateGesture(); return; }
    }
    const a = this.action;
    const p = this.pt(e);
    this.hover = p;
    this.updateStatus(p);
    if (!a) {
      const h = this.captionHandleAt(p);
      this.scroll.style.cursor = h ? HANDLE_CURSORS[h.k] : this.toolCursor();
      this.renderOverlay();
      return;
    }
    if (a.capResize) { this.resizeCaption(p); return; }

    switch (a.tool) {
      case 'pan':
        this.scroll.scrollLeft = a.sl - (e.clientX - a.sx);
        this.scroll.scrollTop = a.st - (e.clientY - a.sy);
        break;
      case 'brush':
      case 'eraser':
      {
        const evs = e.getCoalescedEvents?.();
        for (const ev of evs?.length ? evs : [e]) this.continueStroke(this.pt(ev), ev);
      }
        this.requestRender();
        break;
      case 'picker':
        if (e.buttons) this.pickAt(p);
        break;
      case 'rect': {
        const [x0, y0] = a.sel[0];
        a.sel = [[x0, y0], [p.x, y0], [p.x, p.y], [x0, p.y]];
        this.renderOverlay();
        break;
      }
      case 'lasso': {
        const last = a.sel[a.sel.length - 1];
        if (Math.hypot(p.x - last[0], p.y - last[1]) * this.zoom > 2) a.sel.push([p.x, p.y]);
        this.renderOverlay();
        break;
      }
      case 'move':
        if (a.capDrag) { this.dragCaption(p); break; }
        if (!this.floating) break;
        {
          const dx = Math.round(p.x - a.start.x), dy = Math.round(p.y - a.start.y);
          this.floating.dx = a.origin.dx + dx;
          this.floating.dy = a.origin.dy + dy;
          if (a.selOrig) this.setSelection(a.selOrig.map(([x, y]) => [x + dx, y + dy]));
          this.requestRender();
        }
        break;
      case 'caption':
        if (a.capDrag) this.dragCaption(p);
        break;
    }
  }

  toolCursor() { return { move: 'move', caption: 'text' }[this.tool] || 'crosshair'; }

  onUp(e) {
    if (e.pointerType === 'touch') {
      this.touches.delete(e.pointerId);
      if (this.gesture) {
        if (!this.touches.size) this.endGesture(); // lifting the last finger ends the gesture
        return;
      }
    }
    const a = this.action;
    if (!a) return;
    this.action = null;
    const p = this.pt(e);
    if (a.tool === 'fill' && a.pending) { if (this.paintable()) this.fillAt(a.start); return; }
    if (a.capResize) { if (a.capResize.pushed) this.renderCaptionPanel(); this.renderOverlay(); return; }
    switch (a.tool) {
      case 'brush':
      case 'eraser':
        this.endStroke(p, e);
        break;
      case 'rect': {
        const [x0, y0] = a.sel[0];
        const x1 = clamp(p.x, -1e5, 1e5), y1 = p.y;
        if (Math.abs(x1 - x0) * this.zoom < 3 || Math.abs(y1 - y0) * this.zoom < 3) this.clearSelection();
        else {
          const L = Math.round(Math.min(x0, x1)), R = Math.round(Math.max(x0, x1));
          const T = Math.round(Math.min(y0, y1)), B = Math.round(Math.max(y0, y1));
          this.setSelection([[L, T], [R, T], [R, B], [L, B]]);
        }
        break;
      }
      case 'lasso':
        if (a.sel.length < 3) this.clearSelection();
        else this.setSelection(a.sel);
        break;
      case 'move':
      case 'caption':
        if (a.capDrag?.moved) this.renderCaptionPanel();
        break;
    }
    this.renderOverlay();
  }

  updateStatus(p) {
    const inside = p && p.x >= 0 && p.y >= 0 && p.x < this.W && p.y < this.H;
    $('#status').textContent =
      `${inside ? `${Math.floor(p.x)}, ${Math.floor(p.y)}  ·  ` : ''}${this.W}×${this.H}  ·  ` +
      `Frame ${this.cur + 1}/${this.frames.length}  ·  ${this.layer?.name ?? ''}`;
  }

  // =====================================================================
  // brush / eraser
  // =====================================================================
  startStroke(p, e, eraser) {
    this.commitFloating();
    this.pushUndo(this.snap(this.frame, this.layer));
    const g = ctx2d(this.strokeBuf);
    g.clearRect(0, 0, this.W, this.H);
    this.stroke = { eraser, last: p, sm: p };
    this.segment(p, p, this.size * this.pressure(e));
    this.requestRender();
  }

  continueStroke(p, e) {
    const s = this.stroke;
    if (!s) return;
    const k = this.smoothing;
    s.sm = { x: s.sm.x + (p.x - s.sm.x) * (1 - k), y: s.sm.y + (p.y - s.sm.y) * (1 - k) };
    this.segment(s.last, s.sm, this.size * this.pressure(e));
    s.last = s.sm;
  }

  endStroke(p, e) {
    const s = this.stroke;
    if (!s) return;
    if (Math.hypot(p.x - s.last.x, p.y - s.last.y) >= 0.5) this.segment(s.last, p, this.size * this.pressure(e));
    const g = ctx2d(this.frame.cels[this.activeId]);
    this.applyStroke(g);
    this.touch(this.frame, this.activeId);
    this.stroke = null;
    if (!s.eraser) this.addRecent(this.color);
    this.render();
    this.updateLayerThumbs();
  }

  segment(a, b, w) {
    const g = ctx2d(this.strokeBuf);
    g.fillStyle = g.strokeStyle = this.color;
    w = Math.max(0.5, w);
    if (Math.hypot(b.x - a.x, b.y - a.y) < 0.5) {
      g.beginPath();
      g.arc(b.x, b.y, w / 2, 0, Math.PI * 2);
      g.fill();
      return;
    }
    g.lineWidth = w;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.stroke();
  }

  /** Composite the stroke buffer onto `g`, respecting selection, opacity and eraser mode. */
  applyStroke(g) {
    g.save();
    if (this.selection) g.clip(this.selection.path);
    g.globalAlpha = this.opacity;
    g.globalCompositeOperation = this.stroke.eraser ? 'destination-out' : 'source-over';
    g.drawImage(this.strokeBuf, 0, 0);
    g.restore();
  }

  // =====================================================================
  // fill bucket & eyedropper
  // =====================================================================
  fillAt(p) {
    const x = Math.floor(p.x), y = Math.floor(p.y);
    const { W, H } = this;
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const t = ctx2d(this.tmp);
    if (this.selection && !t.isPointInPath(this.selection.path, x + 0.5, y + 0.5)) return;
    this.commitFloating();
    const f = this.frame, l = this.layer;
    this.pushUndo(this.snap(f, l));

    let src;
    if ($('#sampleAllInput').checked) {
      t.clearRect(0, 0, W, H);
      this.composite(t, f, { background: false, layersOnly: true });
      src = t.getImageData(0, 0, W, H);
    } else {
      src = ctx2d(f.cels[l.id]).getImageData(0, 0, W, H);
    }
    let mask = floodMask(src, x, y, Number($('#tolInput').value));
    if ($('#fillGrowInput').checked) mask = dilate(mask, W, H);

    const out = new ImageData(W, H);
    const [r, g, b] = hexToRgba(this.color);
    const d = out.data;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const o = i * 4;
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
    }
    t.clearRect(0, 0, W, H);
    t.putImageData(out, 0, 0);
    const cg = ctx2d(f.cels[l.id]);
    cg.save();
    if (this.selection) cg.clip(this.selection.path);
    cg.globalAlpha = this.opacity;
    cg.drawImage(this.tmp, 0, 0);
    cg.restore();
    this.touch(f, l.id);
    this.addRecent(this.color);
    this.render();
    this.updateLayerThumbs();
  }

  pickAt(p) {
    const x = Math.floor(p.x), y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return;
    let px;
    if ($('#sampleAllInput').checked || this.layer.type !== 'raster') {
      px = ctx2d(this.view).getImageData(x, y, 1, 1).data;
    } else {
      px = ctx2d(this.frame.cels[this.activeId]).getImageData(x, y, 1, 1).data;
    }
    if (px[3] === 0) return;
    this.setColor(rgbToHex(px[0], px[1], px[2]));
  }

  // =====================================================================
  // selection & move
  // =====================================================================
  setSelection(points) {
    this.selection = { points, path: this.polyPath(points) };
    this.renderOverlay();
  }

  clearSelection() {
    this.commitFloating();
    this.selection = null;
    this.renderOverlay();
  }

  selectAll() {
    this.commitFloating();
    this.setSelection([[0, 0], [this.W, 0], [this.W, this.H], [0, this.H]]);
  }

  /** Lift the selected pixels (or the whole layer) into a floating canvas that can be dragged. */
  lift(fromCanvas = null) {
    const f = this.frame, l = this.layer;
    this.pushUndo(this.snap(f, l));
    const fl = makeCanvas(this.W, this.H);
    const g = ctx2d(fl);
    const cg = ctx2d(f.cels[l.id]);
    if (fromCanvas) {
      g.drawImage(fromCanvas, 0, 0);
    } else if (this.selection) {
      g.save(); g.clip(this.selection.path); g.drawImage(f.cels[l.id], 0, 0); g.restore();
      cg.save(); cg.clip(this.selection.path); cg.clearRect(0, 0, this.W, this.H); cg.restore();
    } else {
      g.drawImage(f.cels[l.id], 0, 0);
      cg.clearRect(0, 0, this.W, this.H);
    }
    this.floating = { canvas: fl, dx: 0, dy: 0, frameId: f.id, layerId: l.id };
    this.touch(f, l.id);
  }

  commitFloating() {
    const fl = this.floating;
    if (!fl) return;
    this.floating = null;
    const f = this.frameById(fl.frameId);
    if (!f || !f.cels[fl.layerId]) return;
    ctx2d(f.cels[fl.layerId]).drawImage(fl.canvas, fl.dx, fl.dy);
    this.touch(f, fl.layerId);
    this.render();
    this.updateLayerThumbs();
  }

  /** Mirror the selection (or the whole layer) horizontally ('h') or vertically ('v') in place. */
  flip(dir) {
    if (this.layer.type !== 'raster') { toast('Flip works on drawing layers. Pick one in the layers panel.', true); return; }
    if (!this.paintable()) return;
    if (!this.floating) this.lift();
    const fl = this.floating;
    // mirror around the middle of the selection, or of the layer when nothing is selected
    let cx = fl.dx + this.W / 2, cy = fl.dy + this.H / 2;
    const pts = this.selection?.points;
    if (pts) {
      const xs = pts.map(q => q[0]), ys = pts.map(q => q[1]);
      cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    }
    const out = makeCanvas(this.W, this.H);
    const g = ctx2d(out);
    if (dir === 'h') g.setTransform(-1, 0, 0, 1, 2 * (cx - fl.dx), 0);
    else g.setTransform(1, 0, 0, -1, 0, 2 * (cy - fl.dy));
    g.drawImage(fl.canvas, 0, 0);
    fl.canvas = out;
    if (pts) this.setSelection(pts.map(([x, y]) => (dir === 'h' ? [2 * cx - x, y] : [x, 2 * cy - y])));
    this.render();
    this.updateLayerThumbs();
    toast(`Flipped ${dir === 'h' ? 'horizontally' : 'vertically'}${pts ? '' : ' (whole layer)'}. Enter drops it, Ctrl+Z undoes.`);
  }

  nudge(dx, dy) {
    if (!this.paintable()) return;
    if (!this.floating) this.lift();
    this.floating.dx += dx;
    this.floating.dy += dy;
    if (this.selection) this.setSelection(this.selection.points.map(([x, y]) => [x + dx, y + dy]));
    this.render();
  }

  clearSelectedPixels() {
    if (this.floating) {
      this.floating = null; // pixels were lifted; dropping them deletes them (undo restores)
      this.render();
      this.updateLayerThumbs();
      return;
    }
    if (!this.selection || !this.paintable()) return;
    const f = this.frame, l = this.layer;
    this.pushUndo(this.snap(f, l));
    const g = ctx2d(f.cels[l.id]);
    g.save(); g.clip(this.selection.path); g.clearRect(0, 0, this.W, this.H); g.restore();
    this.touch(f, l.id);
    this.render();
    this.updateLayerThumbs();
  }

  copy(cut = false, layers = this.selectedLayers()) {
    const multi = layers.length > 1;
    if (!multi && this.layer.type !== 'raster') return;
    const c = makeCanvas(this.W, this.H);
    const g = ctx2d(c);
    if (multi) {
      // several layers: copy what they look like together (visible ones, with their opacity)
      g.save();
      if (this.selection) g.clip(this.selection.path);
      for (const l of layers) {
        if (!l.visible) continue;
        g.globalAlpha = l.opacity;
        if (l.type === 'raster') g.drawImage(this.liveLayer(this.frame, l), 0, 0);
        else this.drawCaptions(g, this.frame.cels[l.id], l.opacity);
      }
      g.restore();
    } else if (this.floating) {
      g.drawImage(this.floating.canvas, this.floating.dx, this.floating.dy);
    } else {
      g.save();
      if (this.selection) g.clip(this.selection.path);
      g.drawImage(this.frame.cels[this.activeId], 0, 0);
      g.restore();
    }
    // crop to the selection's bounds for the system clipboard (so other apps get a sensible image)
    let [x0, y0, x1, y1] = [0, 0, this.W, this.H];
    const pts = this.selection?.points;
    if (pts) {
      x0 = clamp(Math.floor(Math.min(...pts.map(q => q[0]))), 0, this.W);
      y0 = clamp(Math.floor(Math.min(...pts.map(q => q[1]))), 0, this.H);
      x1 = clamp(Math.ceil(Math.max(...pts.map(q => q[0]))), 0, this.W);
      y1 = clamp(Math.ceil(Math.max(...pts.map(q => q[1]))), 0, this.H);
    }
    const crop = makeCanvas(Math.max(1, x1 - x0), Math.max(1, y1 - y0));
    ctx2d(crop).drawImage(c, -x0, -y0);
    this.clipboard = { canvas: c, points: pts?.map(p => [...p]), sig: imageSig(crop) };
    this.lastCopy = 'image';
    this.writeSystemClipboard(crop);
    if (cut && multi) this.clearLayersPixels(layers.filter(l => l.type === 'raster'));
    else if (cut) this.clearSelectedPixels();
    toast(`${cut ? 'Cut' : 'Copied'}${multi ? ` ${layers.length} layers merged` : ''}${cut && multi && layers.some(l => l.type === 'caption') ? ' (captions are left in place)' : ''}`);
  }

  /** Ctrl+Shift+C: copy the whole visible frame (inside the selection, if any). */
  copyMerged() { this.copy(false, this.layers); }

  /** Clear the selected area (or everything) on several raster layers, as one undo step. */
  clearLayersPixels(layers) {
    this.commitFloating();
    const f = this.frame, entries = [];
    for (const l of layers) {
      entries.push(this.snap(f, l));
      const g = ctx2d(f.cels[l.id]);
      g.save();
      if (this.selection) g.clip(this.selection.path);
      g.clearRect(0, 0, this.W, this.H);
      g.restore();
      this.touch(f, l.id);
    }
    if (entries.length) this.pushUndo({ kind: 'group', entries });
    this.render();
    this.updateLayerThumbs();
  }

  async writeSystemClipboard(canvas) {
    try {
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    } catch { /* not allowed / unsupported: the internal clipboard still works */ }
  }

  /** Handle a paste event (Ctrl+V or the browser's Paste): images, audio files or caption text. */
  async onPaste(e) {
    if ($('#editor').hidden || isModalOpen() || this.playing) return;
    if (e.target.matches?.('textarea, input[type=text], input[type=number], input:not([type]), select, [contenteditable]')) return; // normal text paste
    const dt = e.clipboardData;
    const files = [...(dt?.files || [])];
    const text = dt?.getData('text/plain') || '';
    e.preventDefault();
    // our own audio clip: the system clipboard holds its marker text (or nothing, if writing it wasn't allowed)
    const ac = this.audioClipboard;
    if (ac && this.lastCopy === 'audio' && (text === ac.marker || (!files.length && !text))) return this.pasteAudioClip();
    const image = files.find(f => f.type.startsWith('image/'));
    const audio = files.find(isAudioFile);
    if (image) return this.pasteImageFile(image);
    if (audio) return this.importAudioFile(audio);
    const wantsCaption = this.tool === 'caption' || this.layer?.type === 'caption';
    if (text.trim() && (wantsCaption || !this.clipboard)) return this.pasteCaptionText(text.trim());
    if (this.clipboard) return this.paste();
    toast('The clipboard has nothing FrameSketch can paste (images, audio files or text).', true);
  }

  /** Paste an image: our own copy keeps its position; anything else is centered and scaled to fit. */
  async pasteImageFile(file) {
    let bmp;
    try { bmp = await createImageBitmap(file); } catch { toast('Could not read the pasted image.', true); return; }
    if (this.clipboard?.sig && sigMatches(this.clipboard.sig, bmp)) { this.paste(); return; }
    if (!this.paintable()) return;
    const s = Math.min(1, this.W / bmp.width, this.H / bmp.height);
    const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
    const x = Math.round((this.W - w) / 2), y = Math.round((this.H - h) / 2);
    const c = makeCanvas(this.W, this.H);
    ctx2d(c).drawImage(bmp, x, y, w, h);
    bmp.close?.();
    this.setTool('move'); // before lifting: switching tools drops (commits) floating pixels
    this.commitFloating();
    this.lift(c);
    this.setSelection([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
    this.render();
    this.updateLayerThumbs();
    toast(`Pasted image${s < 1 ? ' (scaled to fit)' : ''} — drag to place it, Enter to drop it`);
  }

  pasteCaptionText(text) {
    const layer = this.captionTarget(true);
    if (!layer) return;
    const caps = this.frame.cels[layer.id];
    this.pushUndo(this.snap(this.frame, layer));
    const anchor = this.capStyle.anchor && !caps.some(c => c.anchor === this.capStyle.anchor) ? this.capStyle.anchor : null;
    const c = { ...this.capStyle, id: uid(), text, anchor, x: Math.round(this.W / 2), y: Math.round(this.H / 2) };
    caps.push(c);
    this.touch(this.frame, layer.id);
    this.selectCaption(layer.id, c.id);
    this.refreshQuickCaption();
    this.render();
    toast('Pasted text as a caption');
  }

  paste() {
    if (!this.clipboard || !this.paintable()) return;
    this.setTool('move'); // before lifting: switching tools drops (commits) floating pixels
    this.commitFloating();
    this.lift(this.clipboard.canvas);
    if (this.clipboard.points) this.setSelection(this.clipboard.points.map(p => [...p]));
    else this.selection = null;
    this.render();
  }

  /** Copy (or cut) the selected audio clip, or just its selected region on the waveform. */
  copyClip(cut = false) {
    const c = this.clip;
    if (!c) return;
    const what = this.wave.sel ? 'selected audio' : 'audio clip';
    const part = this.wave.sel ? A.keepRange(c.audio, ...this.wave.sel) : c.audio;
    if (!part.samples.length) return;
    const name = this.trackOfClip(c.id)?.name || 'Audio';
    const marker = `FrameSketch audio clip "${name}" (${A.duration(part).toFixed(2)}s)`;
    this.audioClipboard = { audio: part, name, marker };
    this.lastCopy = 'audio';
    navigator.clipboard?.writeText(marker).catch(() => { /* not allowed: the internal clipboard still works */ });
    if (cut) {
      if (this.wave.sel) this.editAudio(A.cutRange);
      else this.deleteAudio(false);
    }
    toast(`${cut ? 'Cut' : 'Copied'} ${what} — Ctrl+V pastes it at the current frame`);
  }

  /** Paste the copied clip at the start of the current frame: on the selected track, or a new one if that spot is taken. */
  pasteAudioClip() {
    const ac = this.audioClipboard;
    if (!ac || !this.frame) return;
    let track = this.track;
    if (track && track.clips.some(c => c.frameId === this.frame.id && c.offset === 0)) track = null;
    const r = this.placeClip(ac.audio, { track, replace: false, name: ac.name });
    toast(`Pasted ${A.duration(ac.audio).toFixed(2)}s on "${r.track.name}" at frame ${this.cur + 1}. Drag it in the tracks to move it.`);
  }

  /**
   * Split the selected clip at `points` (seconds into the clip) so each part is its own clip that
   * can be moved separately. Playback sounds the same right after the split.
   */
  splitClip(points) {
    const c = this.clip;
    if (!c || this.playing) return;
    const track = this.trackOfClip(c.id);
    const { starts } = this.timing();
    const start = starts.get(c.frameId) + c.offset;
    const dur = A.duration(c.audio);
    let max = dur;
    if (c.trim) { const f = this.frameById(c.frameId); max = Math.min(dur, starts.get(f.id) + f.duration - start); }
    const cuts = [...new Set(points)].filter(t => t > 0.01 && t < max - 0.01).sort((a, b) => a - b);
    if (!cuts.length) {
      toast('Click on the waveform where the clip should be split (or Alt+click the clip in the tracks).', true);
      return;
    }
    this.stopPreview();
    this.pushUndo(this.snapTracks());
    const src = c.audio, edges = [0, ...cuts, dur], pieces = [];
    for (let i = 0; i < edges.length - 1; i++) {
      const audio = A.keepRange(src, edges[i], edges[i + 1]);
      if (i === 0) { c.audio = audio; pieces.push(c); continue; } // the snapshot holds copies
      const abs = start + edges[i];
      const f = this.frames[this.frameIndexAt(abs)];
      const piece = { id: uid(), frameId: f.id, offset: Math.max(0, abs - starts.get(f.id)), trim: c.trim, audio };
      track.clips.push(piece);
      pieces.push(piece);
    }
    // select the part you most likely want to move: the selected region, or the part after the cut
    this.selClipId = pieces[1].id;
    this.wave.clearSelection();
    if (this.splitMode) this.setSplitMode(false);
    this.setDirty(true);
    this.renderTrackHeads();
    this.renderTimeline();
    this.refreshAudio();
    toast(`Split into ${pieces.length} clips — drag one in the tracks to move it on its own`);
  }

  /** The Split button: split at a point/region already marked on the waveform, else wait for a click. */
  splitAtCursor() {
    if (this.splitMode) return this.setSplitMode(false);
    if (this.clip && this.wave.cursor != null) return this.splitClip([this.wave.cursor]);
    if (this.clip && this.wave.sel) return this.splitClip(this.wave.sel);
    this.setSplitMode(true);
  }

  /** Split mode: the next click on a clip (in the tracks or on the waveform) splits it there. */
  setSplitMode(on) {
    if (on && !this.tracks.some(t => t.clips.length)) { toast('There is no audio clip to split yet.', true); return; }
    this.splitMode = on;
    const b = $('#btnAudioSplit');
    b.classList.toggle('armed', on);
    b.textContent = on ? 'Click to split… (Esc)' : 'Split';
    $('#audioPanel').classList.toggle('splitting', on);
    if (on) toast('Click a clip in the tracks (or on the waveform) where it should be split. It snaps to frame edges. Esc cancels.');
    this.trackView.hover = null;
    this.trackView.draw();
  }

  onSplitClip(clipId, t) {
    const tr = this.trackOfClip(clipId);
    if (!tr) return;
    this.onSelectClip(tr.id, clipId);
    this.splitClip([t]);
  }

  /** The waveform changed its selection or marked point. */
  onWaveChange() {
    if (this.splitMode && this.clip && this.wave.cursor != null) this.splitClip([this.wave.cursor]);
    else this.refreshAudioButtons();
  }

  // =====================================================================
  // captions
  // =====================================================================
  selectedCaption() {
    const s = this.selCaption;
    if (!s || !this.frame) return null;
    return this.frame.cels[s.layerId]?.find(c => c.id === s.id) || null;
  }

  selectCaption(layerId, id) {
    this.selCaption = id ? { layerId, id } : null;
    this.capEditPushed = false;
    this.renderCaptionPanel();
    this.renderOverlay();
  }

  /** The caption layer that the caption tool should act on (may create one). */
  captionTarget(create) {
    if (this.layer.type === 'caption') return this.layer;
    const top = [...this.layers].reverse().find(l => l.type === 'caption');
    if (top) { this.setActiveLayer(top.id); return top; }
    if (!create) return null;
    this.addLayer('caption');
    return this.layer;
  }

  captionDown(p, create) {
    const layer = this.captionTarget(create);
    if (!layer) return;
    if (!layer.visible) { toast('The caption layer is hidden.', true); this.action = null; return; }
    const caps = this.frame.cels[layer.id];
    const handle = this.captionHandleAt(p);
    if (handle) {
      const c = this.selectedCaption();
      this.action.capResize = { k: handle.k, start: { x: p.x, y: p.y }, box: { ...this.captionBounds(c) }, layerId: this.selCaption.layerId, id: c.id, pushed: false };
      return;
    }
    const hit = [...caps].reverse().find(c => {
      const b = this.captionBounds(c);
      return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
    });
    if (hit) {
      this.selectCaption(layer.id, hit.id);
      const o = this.captionOrigin(this.captionLayout(hit));
      this.action.capDrag = { cap: hit, ox: o.x - p.x, oy: o.y - p.y, layerId: layer.id, moved: false };
    } else if (create) {
      this.pushUndo(this.snap(this.frame, layer));
      // The first caption on a frame goes to the default spot (bottom-center); extra ones go where you click.
      const anchor = this.capStyle.anchor && !caps.some(c => c.anchor === this.capStyle.anchor) ? this.capStyle.anchor : null;
      const c = { ...this.capStyle, id: uid(), text: 'Caption', anchor, x: Math.round(p.x), y: Math.round(p.y - this.capStyle.size * 0.6) };
      caps.push(c);
      this.refreshQuickCaption();
      this.touch(this.frame, layer.id);
      this.selectCaption(layer.id, c.id);
      this.render();
      const ta = $('#capText');
      setTimeout(() => { ta.focus(); ta.select(); }, 0);
      this.action = null;
    } else {
      this.selectCaption(null);
    }
  }

  dragCaption(p) {
    const d = this.action.capDrag;
    if (!d.moved) {
      this.pushUndo(this.snap(this.frame, this.layerById(d.layerId)));
      d.moved = true;
      // the snapshot cloned the array; keep dragging the live object
      d.cap = this.frame.cels[d.layerId].find(c => c.id === d.cap.id);
    }
    const c = d.cap;
    c.x = Math.round(p.x + d.ox);
    c.y = Math.round(p.y + d.oy);
    // Snap back to an anchored spot (top / middle / bottom) when dragged close to one.
    c.anchor = null;
    const h = this.captionLayout(c).h;
    const tol = 12 / this.zoom;
    for (const a of ['bottom', 'top', 'middle']) {
      const q = this.captionAnchorPos(c, h, a);
      if (Math.abs(q.x - c.x) < tol && Math.abs(q.y - c.y) < tol) { c.anchor = a; break; }
    }
    if (c.anchor !== d.shownAnchor) { d.shownAnchor = c.anchor; this.renderCaptionPanel(); }
    this.touch(this.frame, d.layerId);
    this.requestRender();
  }

  /** Drag a handle of a free caption's box: the text re-wraps to the new width. */
  resizeCaption(p) {
    const r = this.action.capResize;
    if (!r.pushed) { this.pushUndo(this.snap(this.frame, this.layerById(r.layerId))); r.pushed = true; }
    const c = this.frame.cels[r.layerId].find(x => x.id === r.id);
    if (!c) return;
    const b = r.box, dx = p.x - r.start.x, dy = p.y - r.start.y;
    const pad = c.size * 0.25, minW = c.size + 2 * pad, minH = c.size * 1.2 + 2 * pad;
    let x0 = b.x, x1 = b.x + b.w, y0 = b.y, y1 = b.y + b.h;
    if (r.k.includes('w')) x0 = Math.min(x0 + dx, x1 - minW);
    if (r.k.includes('e')) x1 = Math.max(x1 + dx, x0 + minW);
    if (r.k.includes('n')) y0 = Math.min(y0 + dy, y1 - minH);
    if (r.k.includes('s')) y1 = Math.max(y1 + dy, y0 + minH);
    const w = Math.round(x1 - x0), h = Math.round(y1 - y0);
    c.boxW = w;
    c.boxH = h;
    c.x = Math.round(c.align === 'center' ? x0 + w / 2 : c.align === 'left' ? x0 + pad : x0 + w - pad);
    c.y = Math.round(y0 + pad);
    // text that doesn't fit makes the box taller; when dragging the top edge, grow it upwards
    const L = this.captionLayout(c);
    if (r.k.includes('n') && L.box.h > h) c.y = Math.round(y1 - L.box.h + pad);
    this.touch(this.frame, r.layerId);
    this.requestRender();
    this.renderCaptionPanel();
  }

  /** Back to a box that fits the text. */
  autoSizeCaption() {
    const c = this.selectedCaption();
    if (!c || !c.boxW) return;
    this.pushUndo(this.snap(this.frame, this.layerById(this.selCaption.layerId)));
    const live = this.selectedCaption();
    const before = this.captionLayout(live);
    delete live.boxW;
    delete live.boxH;
    live.y = Math.round(before.top); // keep the text where it is
    this.touch(this.frame, this.selCaption.layerId);
    this.capEditPushed = false;
    this.renderCaptionPanel();
    this.render();
  }

  renderCaptionPanel() {
    const c = this.selectedCaption();
    $('#captionPanel').hidden = !c;
    if (!c) return;
    $$('#capAnchor button').forEach(b => b.classList.toggle('active', b.dataset.anchor === (c.anchor || '')));
    $('#capMargin').value = c.margin ?? CAPTION_STYLE.margin;
    $('#capMargin').disabled = !c.anchor;
    $('#capAutoSize').hidden = !!c.anchor || !c.boxW;
    $('#capSizeHint').hidden = !!c.anchor;
    if (document.activeElement !== $('#capText')) $('#capText').value = c.text; // don't fight the cursor
    $('#capSize').value = c.size;
    $('#capFont').value = c.font;
    $('#capColor').value = c.color;
    $('#capOutline').value = c.outline;
    $('#capBox').value = c.box;
    $('#capBoxAlpha').value = Math.round(c.boxAlpha * 100);
    $('#capAlign').value = c.align;
    $('#capBold').checked = c.bold;
  }

  editCaption(prop, value) {
    const c = this.selectedCaption();
    if (!c) return;
    if (!this.capEditPushed) {
      this.pushUndo(this.snap(this.frame, this.layerById(this.selCaption.layerId)));
      this.capEditPushed = true;
    }
    const live = this.selectedCaption(); // snapshot is a clone; the live object is unchanged
    const goingFree = prop === 'anchor' && !value && live.anchor;
    const before = goingFree ? this.captionLayout(live) : null;
    live[prop] = value;
    if (goingFree) {
      // keep the text exactly where it is now (a resized box may center it differently)
      live.x = Math.round(before.x);
      live.y = Math.round(before.top);
      const after = this.captionLayout(live);
      live.y = Math.round(live.y + before.top - after.top);
    }
    if (prop !== 'text') this.capStyle[prop] = value; // new captions use the last style you picked
    this.touch(this.frame, this.selCaption.layerId);
    if (prop === 'text') this.refreshQuickCaption();
    if (prop === 'anchor' || prop === 'margin') this.renderCaptionPanel();
    this.render();
  }

  /** Give every caption on this caption layer, on every frame, the selected caption's style and position. */
  applyCaptionStyleAll() {
    const c = this.selectedCaption();
    if (!c) return;
    const layer = this.layerById(this.selCaption.layerId);
    const style = pick(c, STYLE_KEYS);
    if (!c.anchor) Object.assign(style, { x: c.x, y: c.y, boxW: c.boxW || 0, boxH: c.boxH || 0 });
    const entries = [];
    let n = 0;
    for (const f of this.frames) {
      if (!f.cels[layer.id]?.length) continue;
      entries.push(this.snap(f, layer));
      for (const cap of f.cels[layer.id]) { Object.assign(cap, style); n++; }
      this.touch(f, layer.id);
    }
    this.pushUndo({ kind: 'group', entries });
    this.capStyle = { ...this.capStyle, ...pick(c, STYLE_KEYS) };
    this.capEditPushed = false;
    this.render();
    toast(`Applied to ${n} caption${n === 1 ? '' : 's'} on ${entries.length} frame${entries.length === 1 ? '' : 's'}`);
  }

  // ---------------- quick caption box (under the canvas) ----------------
  /** The frame's "main" caption: the first caption on the topmost caption layer. */
  primaryCaption(create = false) {
    let layer = [...this.layers].reverse().find(l => l.type === 'caption');
    if (!layer) {
      if (!create) return null;
      const keep = this.activeId;
      this.addLayer('caption');
      layer = this.layer;
      this.setActiveLayer(keep);
    }
    const caps = this.frame.cels[layer.id];
    if (!caps.length && create) {
      caps.push({ ...this.capStyle, id: uid(), text: '', anchor: this.capStyle.anchor || 'bottom', x: Math.round(this.W / 2), y: Math.round(this.H * 0.8) });
    }
    return caps.length ? { layer, cap: caps[0] } : null;
  }

  refreshQuickCaption() {
    const inp = $('#frameCaption');
    if (!this.frame || document.activeElement === inp) return;
    inp.value = this.primaryCaption()?.cap.text ?? '';
  }

  quickCaptionInput(text) {
    const had = this.primaryCaption();
    if (!had && !text) return;
    if (!this.quickPushed) {
      const layer = had?.layer || [...this.layers].reverse().find(l => l.type === 'caption');
      if (layer) this.pushUndo(this.snap(this.frame, layer));
      this.quickPushed = true;
    }
    const { layer, cap } = this.primaryCaption(true);
    cap.text = text;
    this.touch(this.frame, layer.id);
    if (this.selCaption?.id === cap.id) this.renderCaptionPanel();
    this.render();
  }

  /** Leaving the quick caption box: drop a caption that was emptied. */
  quickCaptionDone() {
    this.quickPushed = false;
    const p = this.primaryCaption();
    if (p && !p.cap.text.trim()) {
      const caps = this.frame.cels[p.layer.id];
      caps.splice(caps.indexOf(p.cap), 1);
      if (this.selCaption?.id === p.cap.id) this.selectCaption(null);
      this.touch(this.frame, p.layer.id);
      this.render();
    }
  }

  deleteCaption() {
    const s = this.selCaption;
    if (!s) return;
    this.pushUndo(this.snap(this.frame, this.layerById(s.layerId)));
    const caps = this.frame.cels[s.layerId];
    caps.splice(caps.findIndex(c => c.id === s.id), 1);
    this.touch(this.frame, s.layerId);
    this.selectCaption(null);
    this.render();
  }

  captionToNextFrame() {
    const c = this.selectedCaption();
    const next = this.frames[this.cur + 1];
    if (!c) return;
    if (!next) { toast('This is the last frame.', true); return; }
    const lid = this.selCaption.layerId;
    this.pushUndo(this.snap(next, this.layerById(lid)));
    next.cels[lid].push({ ...structuredClone(c), id: uid() });
    this.touch(next, lid);
    this.renderTimeline();
    toast(`Copied caption to frame ${this.cur + 2}`);
  }

  // =====================================================================
  // undo / redo
  // =====================================================================
  snap(f, l) {
    if (l.type === 'raster') {
      return { kind: 'raster', frameId: f.id, layerId: l.id, data: ctx2d(f.cels[l.id]).getImageData(0, 0, this.W, this.H) };
    }
    return { kind: 'caption', frameId: f.id, layerId: l.id, data: structuredClone(f.cels[l.id]) };
  }

  snapTracks() { return { kind: 'tracks', data: cloneTracks(this.tracks) }; }

  pushUndo(entry) {
    this.lastRedo = this.redoStack; // a cancelled stroke (second finger landed) puts this back
    this.undoStack.push(entry);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    if (this.frames?.length) { $('#qbUndo').disabled = false; $('#qbRedo').disabled = true; }
  }

  applyEntry(e, navigate = true) {
    if (e.kind === 'group') {
      const inv = e.entries.map(x => this.applyEntry(x, false)).filter(Boolean).reverse();
      return inv.length ? { kind: 'group', entries: inv } : null;
    }
    if (e.kind === 'tracks') {
      const inverse = this.snapTracks();
      this.tracks = cloneTracks(e.data);
      if (!this.tracks.some(t => t.id === this.selTrackId)) this.selTrackId = this.tracks[0]?.id ?? null;
      this.setDirty(true);
      this.renderTrackHeads();
      return inverse;
    }
    const f = this.frameById(e.frameId);
    if (!f) return null;
    const l = this.layerById(e.layerId);
    if (!l || l.type !== e.kind) return null;
    const inverse = this.snap(f, l);
    if (e.kind === 'raster') ctx2d(f.cels[l.id]).putImageData(e.data, 0, 0);
    else f.cels[l.id] = structuredClone(e.data);
    this.touch(f, e.layerId);
    const i = this.frames.indexOf(f);
    if (navigate && i !== this.cur) this.goto(i);
    return inverse;
  }

  history(from, to) {
    if (this.floating) { this.floating = null; this.selection = null; }
    this.stopPreview();
    while (from.length) {
      const inv = this.applyEntry(from.pop());
      if (inv) { to.push(inv); break; }
    }
    if (this.selCaption && !this.selectedCaption()) this.selCaption = null;
    this.renderCaptionPanel();
    this.refreshQuickCaption();
    this.renderTimeline();
    this.refreshAudio();
    this.updateLayerThumbs();
    this.render();
  }

  undo() { this.history(this.undoStack, this.redoStack); this.syncQuickBar(); }
  redo() { this.history(this.redoStack, this.undoStack); this.syncQuickBar(); }

  // =====================================================================
  // layers
  // =====================================================================
  renderLayers() {
    const ul = $('#layerList');
    ul.innerHTML = '';
    for (const l of [...this.layers].reverse()) {
      const thumb = makeCanvas(88, 52);
      thumb.dataset.layer = l.id;
      const li = el('li', {
        class: l.id === this.activeId ? 'active' : this.extraLayers.has(l.id) ? 'multi' : '',
        title: 'Ctrl+click or Shift+click to select several layers (Ctrl+C then copies them merged)',
        onclick: e => this.clickLayer(l.id, e),
      },
        el('button', {
          class: 'eye' + (l.visible ? '' : ' off'), title: l.visible ? 'Hide' : 'Show', textContent: '👁',
          onclick: e => { e.stopPropagation(); l.visible = !l.visible; this.setDirty(true); this.renderLayers(); this.render(); this.scheduleThumb(this.frame); },
        }),
        thumb,
        el('span', { class: 'lname', textContent: l.name, title: 'Double-click to rename' }),
        el('span', { class: 'ltype', textContent: l.type === 'caption' ? 'CC' : '' }),
      );
      li.addEventListener('dblclick', async () => {
        const name = await promptModal('Rename layer', 'Layer name', l.name);
        if (name) { l.name = name; this.setDirty(true); this.renderLayers(); }
      });
      ul.append(li);
    }
    const l = this.layer;
    $('#layerOpInput').value = Math.round(l.opacity * 100);
    $('#layerOpOut').textContent = Math.round(l.opacity * 100) + '%';
    const idx = this.layers.indexOf(l);
    $('#btnLayerUp').disabled = idx === this.layers.length - 1;
    $('#btnLayerDown').disabled = idx === 0;
    $('#btnMergeDown').disabled = idx === 0 || l.type !== 'raster' || this.layers[idx - 1].type !== 'raster';
    $('#btnDelLayer').disabled = this.layers.length < 2;
    this.updateLayerThumbs();
  }

  updateLayerThumbs() {
    for (const c of $$('#layerList canvas')) {
      const l = this.layerById(c.dataset.layer);
      const g = ctx2d(c);
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, c.width, c.height);
      const s = Math.min(c.width / this.W, c.height / this.H);
      g.setTransform(s, 0, 0, s, (c.width - this.W * s) / 2, (c.height - this.H * s) / 2);
      if (l.type === 'raster') g.drawImage(this.liveLayer(this.frame, l), 0, 0);
      else {
        g.fillStyle = '#333'; g.fillRect(0, 0, this.W, this.H);
        this.drawCaptions(g, this.frame.cels[l.id]);
      }
    }
  }

  /** Layer list click: plain = pick one layer; Ctrl = add / remove; Shift = range from the active layer. */
  clickLayer(id, e) {
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      if (e.shiftKey) {
        const a = this.layers.findIndex(l => l.id === this.activeId), b = this.layers.findIndex(l => l.id === id);
        this.extraLayers = new Set(this.layers.slice(Math.min(a, b), Math.max(a, b) + 1).map(l => l.id));
      } else if (this.extraLayers.has(id)) this.extraLayers.delete(id);
      else this.extraLayers.add(id);
      this.extraLayers.delete(this.activeId);
      this.renderLayers();
      const n = this.selectedLayers().length;
      if (n > 1) toast(`${n} layers selected. Ctrl+C copies them merged (Ctrl+Shift+C copies everything visible).`);
      return;
    }
    if (this.extraLayers.size) { this.extraLayers.clear(); this.renderLayers(); }
    this.setActiveLayer(id);
  }

  /** The active layer plus any Ctrl/Shift-selected ones, bottom to top. */
  selectedLayers() {
    return this.layers.filter(l => l.id === this.activeId || this.extraLayers.has(l.id));
  }

  setActiveLayer(id) {
    if (id === this.activeId) return;
    if (this.extraLayers?.size) this.extraLayers.clear();
    this.commitFloating();
    if (this.layer?.type === 'raster') this.lastRasterId = this.activeId;
    this.activeId = id;
    if (this.selCaption && this.selCaption.layerId !== id) this.selectCaption(null);
    this.renderLayers();
  }

  addLayer(type) {
    this.commitFloating();
    const n = this.layers.filter(l => l.type === type).length + 1;
    const l = { id: uid(), name: type === 'caption' ? `Captions ${n}` : `Layer ${n}`, type, visible: true, opacity: 1 };
    this.layers.splice(this.layers.indexOf(this.layer) + 1, 0, l);
    for (const f of this.frames) f.cels[l.id] = type === 'raster' ? makeCanvas(this.W, this.H) : [];
    this.activeId = l.id;
    this.setDirty(true);
    this.renderLayers();
  }

  async deleteLayer() {
    if (this.layers.length < 2) return;
    const l = this.layer;
    if (!await confirmModal('Delete layer', `Delete "${l.name}" from every frame?`)) return;
    this.commitFloating();
    const i = this.layers.indexOf(l);
    this.layers.splice(i, 1);
    for (const f of this.frames) { delete f.cels[l.id]; delete f.cache[l.id]; }
    this.activeId = this.layers[Math.max(0, i - 1)].id;
    if (this.selCaption?.layerId === l.id) this.selectCaption(null);
    this.setDirty(true);
    this.renderLayers();
    this.renderTimeline();
    this.render();
  }

  moveLayer(dir) {
    this.commitFloating();
    const i = this.layers.indexOf(this.layer), j = i + dir;
    if (j < 0 || j >= this.layers.length) return;
    [this.layers[i], this.layers[j]] = [this.layers[j], this.layers[i]];
    this.setDirty(true);
    this.renderLayers();
    this.renderTimeline();
    this.render();
  }

  duplicateLayer() {
    this.commitFloating();
    const src = this.layer;
    const l = { ...src, id: uid(), name: src.name + ' copy' };
    this.layers.splice(this.layers.indexOf(src) + 1, 0, l);
    for (const f of this.frames) {
      if (src.type === 'raster') {
        const c = makeCanvas(this.W, this.H);
        ctx2d(c).drawImage(f.cels[src.id], 0, 0);
        f.cels[l.id] = c;
      } else {
        f.cels[l.id] = structuredClone(f.cels[src.id]).map(c => ({ ...c, id: uid() }));
      }
    }
    this.activeId = l.id;
    this.setDirty(true);
    this.renderLayers();
  }

  async mergeDown() {
    const up = this.layer, i = this.layers.indexOf(up), down = this.layers[i - 1];
    if (!down || up.type !== 'raster' || down.type !== 'raster') return;
    if (!await confirmModal('Merge down', `Merge "${up.name}" into "${down.name}" on every frame? This can't be undone.`, 'Merge')) return;
    this.commitFloating();
    for (const f of this.frames) {
      const g = ctx2d(f.cels[down.id]);
      g.save();
      g.globalAlpha = up.visible ? up.opacity : 0;
      g.drawImage(f.cels[up.id], 0, 0);
      g.restore();
      delete f.cels[up.id]; delete f.cache[up.id]; delete f.cache[down.id];
    }
    this.layers.splice(i, 1);
    this.activeId = down.id;
    this.undoStack = this.undoStack.filter(e => e.layerId !== down.id);
    this.redoStack = [];
    this.setDirty(true);
    this.renderLayers();
    this.renderTimeline();
    this.render();
  }

  // =====================================================================
  // frames / timeline
  // =====================================================================
  renderTimeline() {
    const tl = $('#timeline');
    tl.innerHTML = '';
    const th = Math.round(124 * this.H / this.W);
    this.frames.forEach((f, i) => {
      const c = makeCanvas(248, Math.max(2, th * 2));
      c.style.height = th + 'px';
      const hasCaps = this.layers.some(l => l.type === 'caption' && f.cels[l.id]?.length);
      const clips = this.tracks.reduce((n, t) => n + t.clips.filter(c => c.frameId === f.id).length, 0);
      const card = el('div', { class: 'frame-card' + (i === this.cur ? ' active' : ''), draggable: true, dataset: { i } },
        c,
        el('div', { class: 'fmeta' }, el('b', { textContent: '#' + (i + 1) }), el('span', { textContent: f.duration.toFixed(2) + 's' })),
        el('div', { class: 'badges' },
          clips ? el('span', { class: 'badge', title: `${clips} audio clip${clips > 1 ? 's' : ''} start${clips > 1 ? '' : 's'} here`, textContent: '♪' + (clips > 1 ? ' ' + clips : '') }) : null,
          hasCaps ? el('span', { class: 'badge', textContent: 'CC' }) : null),
      );
      card.addEventListener('click', () => this.goto(i));
      card.addEventListener('dragstart', e => { this.dragFrom = i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); });
      card.addEventListener('dragover', e => {
        e.preventDefault();
        $$('.frame-card').forEach(x => x.classList.remove('drop-before'));
        const r = card.getBoundingClientRect();
        this.dropAt = e.clientX < r.left + r.width / 2 ? i : i + 1;
        (this.dropAt === i ? card : card.nextElementSibling)?.classList.add('drop-before');
      });
      card.addEventListener('dragend', () => $$('.frame-card').forEach(x => x.classList.remove('drop-before')));
      card.addEventListener('drop', e => {
        e.preventDefault();
        if (this.dragFrom == null) return;
        let to = this.dropAt;
        if (to > this.dragFrom) to--;
        this.moveFrameTo(this.dragFrom, to);
        this.dragFrom = null;
      });
      tl.append(card);
      this.drawThumb(c, f);
    });
    const total = this.frames.reduce((s, f) => s + f.duration, 0);
    $('#totalTime').textContent = `${this.frames.length} frame${this.frames.length > 1 ? 's' : ''} · ${total.toFixed(2)}s total`;
  }

  drawThumb(c, f) {
    const g = ctx2d(c);
    const s = c.width / this.W;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.setTransform(s, 0, 0, s, 0, 0);
    this.composite(g, f, { live: true });
    g.setTransform(1, 0, 0, 1, 0, 0);
  }

  scheduleThumb(f) {
    (this.thumbQueue ||= new Set()).add(f);
    clearTimeout(this.thumbTimer);
    this.thumbTimer = setTimeout(() => {
      for (const fr of this.thumbQueue) {
        const i = this.frames.indexOf(fr);
        const card = $('#timeline').children[i];
        if (card) this.drawThumb(card.querySelector('canvas'), fr);
      }
      this.thumbQueue.clear();
    }, 120);
  }

  markActiveCard() {
    [...$('#timeline').children].forEach((c, i) => {
      c.classList.toggle('active', i === this.cur);
      c.classList.toggle('playing', !!this.playing && i === this.cur);
    });
    $('#timeline').children[this.cur]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  refreshFrameUI() {
    if (document.activeElement !== $('#frameDur')) $('#frameDur').value = +this.frame.duration.toFixed(3);
    $('#btnFrameLeft').disabled = this.cur === 0;
    $('#btnFrameRight').disabled = this.cur === this.frames.length - 1;
    $('#btnDelFrame').disabled = this.frames.length < 2;
    this.syncQuickBar();
    this.updateStatus(this.hover);
  }

  goto(i) {
    i = clamp(i, 0, this.frames.length - 1);
    if (i !== this.cur) {
      this.commitFloating();
      this.stopPreview();
      this.selCaption = null;
      this.cur = i;
    }
    this.markActiveCard();
    this.refreshFrameUI();
    this.refreshAudio(true);
    this.renderCaptionPanel();
    this.refreshQuickCaption();
    this.updateLayerThumbs();
    this.render();
  }

  blankFrame(duration) {
    const f = { id: uid(), duration, cels: {}, cache: {} };
    for (const l of this.layers) f.cels[l.id] = l.type === 'raster' ? makeCanvas(this.W, this.H) : [];
    return f;
  }

  addFrame() {
    this.commitFloating();
    this.frames.splice(this.cur + 1, 0, this.blankFrame(this.frame.duration));
    this.setDirty(true);
    this.renderTimeline();
    this.goto(this.cur + 1);
  }

  duplicateFrame() {
    this.commitFloating();
    const src = this.frame;
    const f = { id: uid(), duration: src.duration, cels: {}, cache: { ...src.cache } };
    // clips that only belong to this frame ("stop at frame end") are duplicated with it
    for (const t of this.tracks) {
      for (const c of t.clips.filter(c => c.frameId === src.id && c.trim)) t.clips.push({ ...c, id: uid(), frameId: f.id });
    }
    for (const l of this.layers) {
      if (l.type === 'raster') {
        const c = makeCanvas(this.W, this.H);
        ctx2d(c).drawImage(src.cels[l.id], 0, 0);
        f.cels[l.id] = c;
      } else {
        f.cels[l.id] = structuredClone(src.cels[l.id]).map(c => ({ ...c, id: uid() }));
      }
    }
    this.frames.splice(this.cur + 1, 0, f);
    this.setDirty(true);
    this.renderTimeline();
    this.goto(this.cur + 1);
  }

  async deleteFrame() {
    if (this.frames.length < 2) return;
    if (!await confirmModal('Delete frame', `Delete frame ${this.cur + 1}, including its drawing and captions? ` +
      'Audio clips set to stop at this frame\'s end are deleted too; other clips that start here move to the next frame.')) return;
    this.floating = null;
    const gone = this.frames[this.cur];
    this.frames.splice(this.cur, 1);
    const heir = this.frames[Math.min(this.cur, this.frames.length - 1)];
    for (const t of this.tracks) {
      t.clips = t.clips.filter(c => !(c.frameId === gone.id && c.trim));
      for (const c of t.clips) if (c.frameId === gone.id) { c.frameId = heir.id; c.offset = 0; }
    }
    this.cur = Math.min(this.cur, this.frames.length - 1);
    this.selCaption = null;
    this.setDirty(true);
    this.renderTimeline();
    this.goto(this.cur);
  }

  moveFrameTo(from, to) {
    to = clamp(to, 0, this.frames.length - 1);
    if (from === to) return;
    this.commitFloating();
    const cur = this.frame;
    const [f] = this.frames.splice(from, 1);
    this.frames.splice(to, 0, f);
    this.cur = this.frames.indexOf(cur);
    this.setDirty(true);
    this.renderTimeline();
    this.goto(this.frames.indexOf(f));
  }

  setDuration(sec, all = false) {
    if (!(sec > 0)) return;
    sec = Math.max(0.04, sec);
    for (const f of all ? this.frames : [this.frame]) f.duration = sec;
    this.setDirty(true);
    this.renderTimeline();
    this.refreshFrameUI();
    this.refreshAudio();
  }

  /**
   * Record the scene as a video (with audio) and put the file on the system clipboard, ready
   * to paste into Discord etc. With `download`, save the file instead.
   */
  async copyVideo(download = false) {
    const btn = $('#btnCopyVideo');
    if (this.videoJob) { this.videoJob.cancelled = true; return; }
    this.stop();
    this.stopPreview();
    this.commitFloating();
    const job = (this.videoJob = { cancelled: false });
    const label = btn.textContent;
    btn.classList.add('recording');
    let verb = 'Encoding';
    let res;
    const t0 = performance.now();
    try {
      res = await recordVideo(this, {
        signal: job,
        onFallback: () => {
          verb = 'Recording';
          toast('Fast export isn\'t available in this browser, so the video is recorded in real time. Keep this tab open; click the button again to cancel.');
        },
        onProgress: (t, total) => { btn.textContent = `\u25A0 ${verb} ${t.toFixed(1)} / ${total.toFixed(1)}s`; },
      });
    } catch (e) {
      toast('Video export failed: ' + e.message, true);
    } finally {
      this.videoJob = null;
      btn.classList.remove('recording');
      btn.textContent = label;
    }
    if (!res) { if (job.cancelled) toast('Video export cancelled'); return; }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const name = `${(this.project?.name || 'FrameSketch').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60)} ${stamp}.${res.ext}`;
    const mb = (res.blob.size / 1048576).toFixed(1);
    const big = res.blob.size > 10 * 1048576 ? ` It is over 10 MB, which Discord may refuse without Nitro.` : '';
    const saveFile = () => {
      const a = el('a', { href: URL.createObjectURL(res.blob), download: name });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };
    if (download) { saveFile(); toast(`Saved ${name} (${mb} MB).${big}`); return; }
    const took = ((performance.now() - t0) / 1000).toFixed(1);
    if (api.copyFile) {
      // local server: put the file on the OS clipboard
      try {
        await api.copyFile(name, res.blob);
        toast(`Video copied (${mb} MB ${res.ext.toUpperCase()}, made in ${took}s). Paste it into Discord with Ctrl+V.${big}`);
      } catch (e) {
        saveFile();
        toast(`Could not copy the video to the clipboard (${e.message}), so it was downloaded instead.${big}`, true);
      }
      return;
    }
    // no server: the share sheet on phones / tablets (Discord is in it), a download elsewhere
    const file = new File([res.blob], name, { type: res.type });
    if (this.shareMode()) {
      const share = () => navigator.share({ files: [file], title: name });
      try {
        await share();
        return;
      } catch (e) {
        if (e.name === 'AbortError') return; // closed the share sheet
        if (e.name === 'NotAllowedError') {
          // encoding took long enough that the tap no longer counts; ask for another tap
          if (await modal({ title: 'Video ready', message: `${mb} MB, made in ${took}s. Tap Share to send it to Discord or another app.${big}`, okText: 'Share' })) {
            try { await share(); return; } catch (e2) { if (e2.name === 'AbortError') return; }
          } else return;
        }
      }
    }
    saveFile();
    toast(`Saved ${name} (${mb} MB, made in ${took}s). Drag the file into Discord to post it.${big}`);
  }

  /** Without the server, phones and tablets share the video; desktops download it. */
  shareMode() {
    try {
      return !api.copyFile && matchMedia('(pointer: coarse)').matches &&
        !!navigator.canShare?.({ files: [new File([new Uint8Array(1)], 'x.mp4', { type: 'video/mp4' })] });
    } catch { return false; }
  }

  updateVideoButton() {
    const b = $('#btnCopyVideo');
    if (api.copyFile) { b.textContent = 'Copy video'; return; }
    const share = this.shareMode();
    b.textContent = share ? 'Share video' : 'Save video';
    b.title = share
      ? 'Make a video of the whole scene with audio and open the share sheet (pick Discord to post it). Shift+click saves the file.'
      : 'Make a video of the whole scene with audio and download it as an MP4 (drag it into Discord to post it).';
  }

  // ---------------- touch: pinch to zoom, two fingers to pan ----------------
  /** Undo whatever a first finger started when a second finger lands. */
  cancelAction() {
    const a = this.action;
    this.action = null;
    if (!a) return;
    if (this.stroke) {
      this.stroke = null;
      this.undoStack.pop(); // startStroke pushed one; the stroke wasn't applied yet
      this.redoStack = this.lastRedo || []; // ...and starting it cleared redo (a three-finger tap needs it)
    } else if (a.tool === 'move' && this.floating && a.origin) {
      this.floating.dx = a.origin.dx;
      this.floating.dy = a.origin.dy;
      if (a.selOrig) this.setSelection(a.selOrig);
    }
    this.requestRender();
    this.renderOverlay();
  }

  startGesture() {
    const [a, b] = [...this.touches.values()];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    this.gesture = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: this.zoom, mx, my, sx: mx, sy: my, t0: performance.now(), fingers: 2, moved: false };
  }

  /** A quick tap with two fingers undoes, with three fingers redoes. */
  endGesture() {
    const g = this.gesture;
    this.gesture = null;
    if (!g || g.moved || performance.now() - g.t0 > 400) return;
    if (g.fingers === 2) { this.undo(); toast('Undo'); }
    else if (g.fingers === 3) { this.redo(); toast('Redo'); }
  }

  updateGesture() {
    const [a, b] = [...this.touches.values()];
    const g = this.gesture;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    if (Math.abs(d - g.d0) > 12 || Math.hypot(mx - g.sx, my - g.sy) > 12) g.moved = true;
    if (!g.moved) return; // could still be a tap
    const z = clamp(g.z0 * d / g.d0, 0.05, 16);
    if (Math.abs(z - this.zoom) > 1e-3) this.setZoom(z, { clientX: mx, clientY: my });
    this.scroll.scrollLeft -= mx - g.mx;
    this.scroll.scrollTop -= my - g.my;
    g.mx = mx;
    g.my = my;
  }

  exportPng() {
    this.commitFloating();
    const c = makeCanvas(this.W, this.H);
    this.composite(ctx2d(c), this.frame);
    c.toBlob(b => {
      const a = el('a', { href: URL.createObjectURL(b), download: `${this.project.name} - frame ${this.cur + 1}.png` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
  }

  // =====================================================================
  // playback (driven by the audio clock so pictures and sound stay in sync)
  // =====================================================================
  timing() {
    const starts = new Map();
    let t = 0;
    for (const f of this.frames) { starts.set(f.id, t); t += f.duration; }
    return { starts, total: t };
  }

  frameIndexAt(t) {
    let acc = 0;
    for (let i = 0; i < this.frames.length; i++) {
      acc += this.frames[i].duration;
      if (t < acc) return i;
    }
    return this.frames.length - 1;
  }

  /**
   * When each clip on a track actually plays. A clip starts at its frame (+ offset) and plays to its
   * end, until the next clip on the same track starts, or (with "stop at frame end") until its frame ends.
   */
  trackSpans(t, timing = this.timing()) {
    const { starts, total } = timing;
    const list = t.clips
      .filter(c => starts.has(c.frameId))
      .map(c => ({ clip: c, start: starts.get(c.frameId) + c.offset }))
      .sort((a, b) => a.start - b.start);
    list.forEach((s, i) => {
      s.natEnd = s.start + A.duration(s.clip.audio);
      let end = s.natEnd;
      s.reason = '';
      const next = list[i + 1];
      if (next && next.start < end) { end = next.start; s.reason = 'the next clip on this track'; }
      if (s.clip.trim) {
        const f = this.frameById(s.clip.frameId);
        const fe = starts.get(f.id) + f.duration;
        if (fe < end) { end = fe; s.reason = 'the end of its frame'; }
      }
      if (total < end) { end = total; s.reason = 'the end of the animation'; }
      s.end = Math.max(s.start, end);
    });
    return list;
  }

  async play() {
    if (this.playing) return this.stop();
    this.commitFloating();
    this.stopPreview();
    this.playing = true;
    $('#btnPlay').innerHTML = '&#9632; Stop';
    const c = A.audioCtx();
    this.playRate = this.speed();
    // At other speeds, play a pitch-corrected mix of all tracks (so voices don't sound sped up)
    this.stretchBuf = null;
    if (this.playRate !== 1 && this.tracks.some(t => !t.muted && t.clips.length)) {
      if (this.playRate < 0.25 || this.playRate > 4) {
        toast('Pitch can only be kept between 25% and 400% speed, so the audio pitch changes here.');
      } else {
        if (this.stretchCache?.key !== this.stretchKey(this.playRate)) {
          toast(`Preparing audio at ${Math.round(this.playRate * 100)}%…`);
          await new Promise(r => setTimeout(r, 30)); // let the message show
          if (!this.playing) return;
        }
        this.stretchBuf = this.stretchedBuffer(this.playRate);
      }
    }
    const { starts } = this.timing();
    const first = this.cur === this.frames.length - 1 && this.frames.length > 1 ? 0 : this.cur;
    this.playSources = new Set();
    this.trackGains = new Map();
    for (const t of this.tracks) {
      const g = c.createGain();
      g.gain.value = t.muted ? 0 : t.volume;
      g.connect(c.destination);
      this.trackGains.set(t.id, g);
    }
    this.schedulePass(starts.get(this.frames[first].id), c.currentTime + 0.05);
    this.cur = first;
    this.selCaption = null;
    this.renderCaptionPanel();
    this.markActiveCard();
    this.render();

    const tick = () => {
      if (!this.playing) return;
      const total = this.timing().total;
      const p = this.pass;
      const rate = this.playRate;
      let t = p.t0 + (c.currentTime - p.at) * rate;
      if (t >= total) {
        if (!$('#chkLoop').checked) { this.stop(); return; }
        const at = p.at + (total - p.t0) / rate;
        this.schedulePass(0, at);
        t = Math.max(0, c.currentTime - at) * rate;
      }
      const i = this.frameIndexAt(Math.max(t, 0));
      if (i !== this.cur) {
        this.cur = i;
        this.markActiveCard();
        this.render();
        this.refreshQuickCaption();
      }
      this.trackView.playhead = Math.max(t, 0);
      this.trackView.draw();
      this.playRaf = requestAnimationFrame(tick);
    };
    tick();
  }

  /** Playback speed from the header box (a testing aid; not saved, export is unaffected). */
  speed() {
    const v = +$('#playSpeed').value;
    return v > 0 ? clamp(v, 5, 1000) / 100 : 1;
  }

  /** What the stretched mix depends on: clips, their placement and gain, mutes, volumes, frame times. */
  stretchKey(rate) {
    this.sampleIds ||= new WeakMap();
    const sid = a => { if (!this.sampleIds.has(a.samples)) this.sampleIds.set(a.samples, (this.nextSampleId = (this.nextSampleId || 0) + 1)); return this.sampleIds.get(a.samples); };
    return [rate, this.frames.map(f => f.id + ':' + f.duration).join(','),
      ...this.tracks.map(t => [t.muted, t.volume, ...t.clips.map(c => [c.frameId, c.offset, c.trim, c.audio.gain, sid(c.audio)].join(':'))].join('/'))].join('|');
  }

  /** All unmuted tracks mixed and time-stretched to `rate` without changing pitch (cached). */
  stretchedBuffer(rate) {
    const key = this.stretchKey(rate);
    if (this.stretchCache?.key === key) return this.stretchCache.buf;
    const SR = 24000; // a preview: plenty for voice, keeps stretching quick
    const timing = this.timing();
    const parts = [];
    for (const t of this.tracks) {
      if (t.muted) continue;
      for (const s of this.trackSpans(t, timing)) parts.push({ audio: s.clip.audio, start: s.start, end: s.end, gain: t.volume });
    }
    const mixed = A.mixParts(parts, timing.total, SR);
    const out = A.timeStretch(mixed, SR, rate);
    const buf = A.audioCtx().createBuffer(1, out.length, SR);
    buf.copyToChannel(out, 0);
    this.stretchCache = { key, buf };
    return buf;
  }

  /** Schedule every track's audio from timeline second `t0`, which plays at audio-clock time `at`. */
  schedulePass(t0, at) {
    this.pass = { t0, at };
    if (this.stretchBuf) {
      // one pre-mixed, pitch-corrected buffer; its time runs 1/rate as fast as the timeline
      const off = t0 / this.playRate;
      if (off >= this.stretchBuf.duration) return;
      const c = A.audioCtx();
      const src = c.createBufferSource();
      src.buffer = this.stretchBuf;
      src.connect(c.destination);
      const late = Math.max(0, c.currentTime - at);
      src.start(at + late, off + late);
      this.playSources.add(src);
      src.onended = () => this.playSources?.delete(src);
      return;
    }
    const timing = this.timing();
    for (const t of this.tracks) {
      const dest = this.trackGains.get(t.id);
      if (!dest) continue;
      for (const s of this.trackSpans(t, timing)) {
        if (s.end <= t0) continue;
        const from = Math.max(s.start, t0);
        const src = A.scheduleClip(s.clip.audio, at + (from - t0) / this.playRate, from - s.start, s.end - from, dest, this.playRate);
        if (!src) continue;
        this.playSources.add(src);
        src.onended = () => this.playSources?.delete(src);
      }
    }
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.playRaf);
    for (const s of this.playSources || []) { try { s.stop(); } catch { /* already stopped */ } }
    for (const g of this.trackGains?.values() || []) g.disconnect();
    this.playSources = null;
    this.trackGains = null;
    this.trackView.playhead = null;
    $('#btnPlay').innerHTML = '&#9654; Play';
    this.goto(this.cur);
  }

  // =====================================================================
  // audio tracks & clips
  // =====================================================================
  get track() { return this.tracks.find(t => t.id === this.selTrackId) || null; }

  get clip() {
    for (const t of this.tracks) {
      const c = t.clips.find(c => c.id === this.selClipId);
      if (c) return c;
    }
    return null;
  }

  trackOfClip(id) { return this.tracks.find(t => t.clips.some(c => c.id === id)); }

  /** Data for the track view (see tracks.js). */
  trackModel() {
    const timing = this.timing();
    let maxEnd = 0;
    const tracks = this.tracks.map((t, i) => {
      const spans = this.trackSpans(t, timing);
      for (const s of spans) maxEnd = Math.max(maxEnd, s.natEnd);
      return { id: t.id, muted: t.muted, color: trackColor(i), spans };
    });
    return {
      frames: this.frames.map(f => ({ start: timing.starts.get(f.id), dur: f.duration })),
      total: timing.total, maxEnd, tracks, cur: this.cur, selClipId: this.selClipId, selTrackId: this.selTrackId,
    };
  }

  onSeek(t) {
    if (this.playing) return;
    this.goto(this.frameIndexAt(clamp(t, 0, this.timing().total)));
  }

  onSelectTrack(id) {
    this.selTrackId = id;
    this.selClipId = null;
    this.wave.clearSelection();
    this.renderTrackHeads();
    this.refreshAudio();
  }

  onSelectClip(trackId, clipId) {
    if (this.selClipId !== clipId) this.wave.clearSelection();
    this.stopPreview();
    this.selTrackId = trackId;
    this.selClipId = clipId;
    this.renderTrackHeads();
    this.refreshAudio();
  }

  /** Dragging a clip in the track view: re-anchor it to the frame under its new start. */
  onMoveClip(clipId, start, trackId) {
    if (this.playing) return;
    if (!this.clipDragPushed) { this.pushUndo(this.snapTracks()); this.clipDragPushed = true; }
    const from = this.trackOfClip(clipId);
    if (!from) return;
    const to = this.tracks.find(t => t.id === trackId) || from;
    const clip = from.clips.find(c => c.id === clipId);
    if (to !== from) {
      from.clips.splice(from.clips.indexOf(clip), 1);
      to.clips.push(clip);
      this.selTrackId = to.id;
      this.renderTrackHeads();
    }
    const { starts } = this.timing();
    const f = this.frames[this.frameIndexAt(start)];
    clip.frameId = f.id;
    clip.offset = Math.max(0, Math.round((start - starts.get(f.id)) * 1000) / 1000);
    this.setDirty(true);
    this.refreshAudio();
  }

  onMoveClipEnd() {
    this.clipDragPushed = false;
    this.renderTimeline();
  }

  /**
   * Keep a sensible clip selected as you move between frames: the selected one if it is still
   * playing here, otherwise the selected track's clip that starts on (or is playing at) this frame.
   */
  autoSelectClip() {
    const t = this.track;
    if (!t || !this.frame) { this.selClipId = null; return; }
    const { starts } = this.timing();
    const f0 = starts.get(this.frame.id), f1 = f0 + this.frame.duration;
    const spans = this.trackSpans(t);
    const covers = s => s.start < f1 && s.end > f0;
    const cur = spans.find(s => s.clip.id === this.selClipId);
    if (cur && covers(cur)) return;
    const best = spans.find(s => s.clip.frameId === this.frame.id) || spans.find(covers);
    if ((best?.clip.id ?? null) !== this.selClipId) this.wave.clearSelection();
    this.selClipId = best?.clip.id ?? null;
  }

  renderTrackHeads() {
    const box = $('#trackHeads');
    box.innerHTML = '';
    box.append(el('div', { class: 'ruler-space', textContent: 'Tracks' }));
    this.tracks.forEach((t, i) => {
      const vol = el('input', { type: 'range', min: 0, max: 200, value: Math.round(t.volume * 100), title: `Volume ${Math.round(t.volume * 100)}%` });
      vol.addEventListener('click', e => e.stopPropagation());
      vol.addEventListener('input', () => {
        t.volume = +vol.value / 100;
        vol.title = `Volume ${vol.value}%`;
        const g = this.trackGains?.get(t.id);
        if (g && !t.muted) g.gain.value = t.volume;
        this.setDirty(true);
      });
      const row = el('div', { class: 'track-head' + (t.id === this.selTrackId ? ' active' : ''), onclick: () => this.onSelectTrack(t.id) },
        el('span', { class: 'swatch', style: `background:${trackColor(i)}` }),
        el('span', { class: 'tname', textContent: t.name, title: `${t.name} (double-click to rename)` }),
        el('button', {
          class: 'mute' + (t.muted ? ' on' : ''), textContent: 'M', title: t.muted ? 'Unmute' : 'Mute',
          onclick: e => {
            e.stopPropagation();
            t.muted = !t.muted;
            const g = this.trackGains?.get(t.id);
            if (g) g.gain.value = t.muted ? 0 : t.volume;
            this.setDirty(true);
            this.renderTrackHeads();
            this.trackView.draw();
          },
        }),
        vol,
        el('button', { class: 'danger', textContent: '×', title: 'Delete track', onclick: e => { e.stopPropagation(); this.deleteTrack(t.id); } }),
      );
      row.addEventListener('dblclick', async () => {
        const name = await promptModal('Rename track', 'Track name', t.name);
        if (name) { t.name = name; this.setDirty(true); this.renderTrackHeads(); this.refreshAudio(); }
      });
      box.append(row);
    });
  }

  addTrack(name) {
    this.pushUndo(this.snapTracks());
    const t = newTrack(name || `Track ${this.tracks.length + 1}`);
    this.tracks.push(t);
    this.selTrackId = t.id;
    this.selClipId = null;
    this.setDirty(true);
    this.renderTrackHeads();
    this.refreshAudio();
    return t;
  }

  async deleteTrack(id) {
    const t = this.tracks.find(x => x.id === id);
    if (!t) return;
    if (t.clips.length && !await confirmModal('Delete track', `Delete "${t.name}" and its ${t.clips.length} clip${t.clips.length > 1 ? 's' : ''}? (Ctrl+Z undoes this.)`)) return;
    this.stopPreview();
    this.pushUndo(this.snapTracks());
    const i = this.tracks.indexOf(t);
    this.tracks.splice(i, 1);
    if (this.selTrackId === id) this.selTrackId = this.tracks[Math.max(0, i - 1)]?.id ?? null;
    if (!this.clip) this.selClipId = null;
    this.setDirty(true);
    this.renderTrackHeads();
    this.renderTimeline();
    this.refreshAudio();
  }

  /** Put a new clip on a track at the start of the current frame (creating a track if there is none). */
  placeClip(audio, { track = this.track, replace = true, name = 'Voice' } = {}) {
    const fid = this.frame.id;
    this.pushUndo(this.snapTracks());
    if (!track) {
      track = newTrack(name);
      this.tracks.push(track);
    }
    let replaced = false;
    if (replace) {
      const old = track.clips.findIndex(c => c.frameId === fid && c.offset === 0);
      if (old >= 0) { track.clips.splice(old, 1); replaced = true; }
    }
    const clip = { id: uid(), frameId: fid, offset: 0, trim: false, audio };
    track.clips.push(clip);
    this.selTrackId = track.id;
    this.selClipId = clip.id;
    this.wave.clearSelection();
    this.setDirty(true);
    this.renderTrackHeads();
    this.renderTimeline();
    this.refreshAudio();
    return { clip, track, replaced };
  }

  refreshAudio(autoSelect = false) {
    if (!this.frame) return;
    if (autoSelect && !this.playing) this.autoSelectClip();
    const c = this.clip;
    if (!c) this.selClipId = null;
    const timing = this.timing();
    const span = c ? this.trackSpans(this.trackOfClip(c.id), timing).find(s => s.clip.id === c.id) : null;
    // frame edges, in seconds into the clip, so a clicked split point can snap to them
    if (c) {
      const c0 = timing.starts.get(c.frameId) + c.offset, len = A.duration(c.audio);
      this.wave.snaps = this.frames.flatMap(f => { const s0 = timing.starts.get(f.id) - c0; return [s0, s0 + f.duration]; })
        .filter(t => t > 0 && t < len);
    } else this.wave.snaps = [];
    // the yellow marker on the waveform shows where the clip gets cut off
    this.wave.set(c?.audio || null, span && span.end < span.natEnd - 1e-3 ? span.end - span.start : 0);
    $('#waveEmpty').hidden = !!c || this.mic.recording;
    let info = '';
    if (c && span) {
      const fi = this.frames.findIndex(f => f.id === c.frameId);
      info = `${this.trackOfClip(c.id).name} · ${A.duration(c.audio).toFixed(2)}s clip · starts frame ${fi + 1}` +
        (c.offset ? ` +${c.offset.toFixed(2)}s` : '') +
        (span.reason ? ` · plays ${(span.end - span.start).toFixed(2)}s (cut by ${span.reason})` : '');
    } else if (this.track) {
      info = `Track "${this.track.name}" · no clip at frame ${this.cur + 1}`;
    }
    $('#audioInfo').textContent = info;
    if (c) {
      $('#audioGain').value = Math.round(c.audio.gain * 100);
      $('#audioGainOut').textContent = Math.round(c.audio.gain * 100) + '%';
      $('#clipTrim').checked = c.trim;
    }
    this.refreshAudioButtons();
    this.trackView.draw();
    if (!this.playing) {
      const f0 = timing.starts.get(this.frame.id);
      this.trackView.reveal(f0, f0 + this.frame.duration);
    }
  }

  refreshAudioButtons() {
    const has = !!this.clip, sel = !!this.wave.sel;
    $('#btnAudioSplit').disabled = !this.tracks.some(t => t.clips.length);
    for (const id of ['btnAudioPlay', 'btnAudioNormalize', 'btnAudioDelete', 'audioGain', 'clipTrim']) $('#' + id).disabled = !has;
    for (const id of ['btnAudioPlaySel', 'btnAudioKeep', 'btnAudioCut', 'btnAudioSilence']) $('#' + id).disabled = !has || !sel;
    $('#btnAudioFit').disabled = !has || this.clip.frameId !== this.frame?.id;
  }

  async toggleRecord() {
    const btn = $('#btnRecord');
    if (this.mic.recording) {
      const fid = this.recFrameId, tid = this.recTrackId;
      this.endRecordingUI();
      try {
        const clip = await this.mic.stop();
        const f = this.frameById(fid);
        if (f && clip && clip.samples.length) {
          const i = this.frames.indexOf(f);
          if (i !== this.cur) this.goto(i);
          const track = this.tracks.find(t => t.id === tid) || this.track;
          const r = this.placeClip(clip, { track });
          toast(`Recorded ${A.duration(clip).toFixed(1)}s on "${r.track.name}" at frame ${i + 1}${r.replaced ? ' (replaced the old take, Ctrl+Z to undo)' : ''}`);
        }
      } catch (e) {
        toast('Could not process recording: ' + e.message, true);
      }
      this.refreshAudio();
      return;
    }
    this.stopPreview();
    try {
      await this.mic.start();
    } catch (e) {
      toast('Microphone unavailable: ' + (e.message || e.name), true);
      return;
    }
    this.recFrameId = this.frame.id;
    this.recTrackId = this.selTrackId;
    btn.classList.add('recording');
    btn.innerHTML = '&#9632; Stop recording';
    $('#waveEmpty').hidden = true;
    this.recTimer = setInterval(() => {
      const t = this.mic.elapsed();
      $('#recTimer').textContent = t.toFixed(1) + 's';
      this.wave.live = t;
      this.wave.draw();
    }, 100);
  }

  endRecordingUI() {
    clearInterval(this.recTimer);
    this.wave.live = null;
    $('#recTimer').textContent = '';
    const btn = $('#btnRecord');
    btn.classList.remove('recording');
    btn.innerHTML = '&#9679; Record';
  }

  /** Import an audio file at the current frame: onto the selected track if it is free here, else a new track. */
  async importAudioFile(file) {
    if (!this.frame) return;
    toast(`Importing "${file.name}"…`);
    let audio;
    try {
      audio = await A.fileToClip(file);
    } catch (e) {
      toast(e.message, true);
      return;
    }
    const base = ((file.name || 'Audio').replace(/\.[^.]+$/, '') || 'Audio').slice(0, 40);
    let track = this.track;
    if (track && track.clips.some(c => c.frameId === this.frame.id && c.offset === 0)) track = null;
    const r = this.placeClip(audio, { track, replace: false, name: base });
    toast(`Imported ${A.duration(audio).toFixed(1)}s "${base}" on "${r.track.name}" at frame ${this.cur + 1}. Drag it in the tracks to move it.`);
  }

  playAudio(selectionOnly) {
    this.stopPreview();
    const a = this.clip?.audio;
    if (!a) return;
    const [t0, t1] = selectionOnly && this.wave.sel ? this.wave.sel : [0, null];
    const h = A.playClip(a, t0, t1, () => { if (this.preview === h) this.stopPreview(); });
    this.preview = h;
    const tick = () => {
      if (this.preview !== h) return;
      this.wave.playhead = h.position();
      this.wave.draw();
      requestAnimationFrame(tick);
    };
    tick();
  }

  stopPreview() {
    if (!this.preview) return;
    this.preview.stop();
    this.preview = null;
    this.wave.playhead = null;
    this.wave.draw();
  }

  /** Apply an edit (from audio.js) to the selected clip. */
  editAudio(fn, needsSel = true) {
    const c = this.clip;
    if (!c) return;
    if (needsSel && !this.wave.sel) { toast('Drag on the waveform to select a region first.', true); return; }
    this.stopPreview();
    const [t0, t1] = this.wave.sel || [0, 0];
    const next = fn(c.audio, t0, t1);
    if (next === c.audio) return;
    this.pushUndo(this.snapTracks());
    if (next.samples.length) c.audio = next; // the snapshot holds copies of the clip objects
    else this.removeClip(c.id);
    this.wave.clearSelection();
    this.setDirty(true);
    this.renderTimeline();
    this.refreshAudio();
  }

  removeClip(id) {
    const t = this.trackOfClip(id);
    if (t) t.clips = t.clips.filter(c => c.id !== id);
    if (this.selClipId === id) this.selClipId = null;
  }

  deleteAudio(announce = true) {
    const c = this.clip;
    if (!c) return;
    this.stopPreview();
    this.pushUndo(this.snapTracks());
    this.removeClip(c.id);
    this.setDirty(true);
    this.renderTimeline();
    this.refreshAudio();
    if (announce) toast('Clip deleted (Ctrl+Z to undo)');
  }

  // =====================================================================
  // UI wiring
  // =====================================================================
  bindUI() {
    const on = (sel, ev, fn) => $(sel).addEventListener(ev, fn);

    // top bar
    on('#btnBack', 'click', () => this.onBack());
    on('#btnSave', 'click', () => this.save());
    on('#btnSaveAs', 'click', () => this.saveAs());
    on('#btnUndo', 'click', () => this.undo());
    on('#btnRedo', 'click', () => this.redo());
    on('#btnZoomIn', 'click', () => this.zoomStep(1));
    on('#btnZoomOut', 'click', () => this.zoomStep(-1));
    on('#btnZoomFit', 'click', () => this.fit());
    on('#btnPlay', 'click', () => this.play());
    on('#chkOnion', 'change', () => this.render());
    on('#btnExportPng', 'click', () => this.exportPng());
    on('#btnCopyVideo', 'click', e => this.copyVideo(e.shiftKey));

    // tools
    $$('#toolbar button[data-tool]').forEach(b => b.addEventListener('click', () => this.setTool(b.dataset.tool)));
    on('#playSpeed', 'change', e => {
      const v = this.speed();
      e.target.value = Math.round(v * 100);
      e.target.parentElement.classList.toggle('changed', v !== 1);
      if (this.playing) { this.stop(); this.play(); } // restart from the current frame at the new speed
    });
    on('#btnFlipH', 'click', () => this.flip('h'));
    on('#btnFlipV', 'click', () => this.flip('v'));
    on('#capAutoSize', 'click', () => this.autoSizeCaption());

    // color
    on('#colorInput', 'input', e => this.setColor(e.target.value));
    on('#hexInput', 'input', e => {
      let v = e.target.value.trim();
      if (!v.startsWith('#')) v = '#' + v;
      if (/^#[0-9a-f]{3}$/i.test(v)) v = '#' + [...v.slice(1)].map(c => c + c).join('');
      this.setColor(v);
    });
    on('#hexInput', 'blur', e => (e.target.value = this.color));
    const sw = $('#swatches');
    for (const c of PALETTE) sw.append(el('button', { title: c, style: `background:${c}`, onclick: () => this.setColor(c) }));

    // tool options
    const range = (sel, out, fmt, set) => on(sel, 'input', e => { const v = +e.target.value; $(out).textContent = fmt(v); set(v); });
    range('#sizeInput', '#sizeOut', v => v, v => { this.size = v; this.renderOverlay(); });
    range('#opacityInput', '#opacityOut', v => v + '%', v => (this.opacity = v / 100));
    range('#smoothInput', '#smoothOut', v => v + '%', v => (this.smoothing = v / 100));
    range('#tolInput', '#tolOut', v => v, () => {});
    // auto-save (on by default; remembered per device)
    try { $('#chkAutoSave').checked = localStorage.getItem('fs.autosave') !== '0'; } catch { /* storage blocked */ }
    on('#chkAutoSave', 'change', e => {
      try { localStorage.setItem('fs.autosave', e.target.checked ? '1' : '0'); } catch { /* storage blocked */ }
      if (e.target.checked && this.dirty) this.scheduleAutoSave(500);
    });
    // phones close background tabs without warning: save when the app is hidden
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && this.dirty && this.autoSaveOn && !this.floating && !this.action) this.save({ quiet: true });
    });
    try {
      const fd = localStorage.getItem('fs.fingerDraws');
      if (fd !== null) $('#fingerDrawInput').checked = fd === '1';
    } catch { /* storage blocked */ }
    on('#fingerDrawInput', 'change', e => { try { localStorage.setItem('fs.fingerDraws', e.target.checked ? '1' : '0'); } catch { /* blocked */ } });
    // quick bar (phones)
    on('#qbUndo', 'click', () => this.undo());
    on('#qbRedo', 'click', () => this.redo());
    on('#qbPrev', 'click', () => this.goto(this.cur - 1));
    on('#qbNext', 'click', () => this.goto(this.cur + 1));
    on('#qbSize', 'input', e => this.setSize(Math.round(1 + (e.target.value / 100) ** 2 * 299)));
    on('#qbColor', 'click', () => $('#btnPanels').click());
    on('#btnShortcuts', 'click', () => this.showShortcuts());
    on('#btnCopySel', 'click', () => this.copy(false));
    on('#btnCutSel', 'click', () => this.copy(true));
    on('#btnPasteSel', 'click', () => (this.clipboard ? this.paste() : toast('Copy something first.', true)));
    on('#btnDropSel', 'click', () => this.commitFloating());
    const setPanels = open => {
      $('#editor').classList.toggle('panels-open', open);
      $('#btnPanels').classList.toggle('active', open);
    };
    on('#btnPanels', 'click', () => setPanels(!$('#editor').classList.contains('panels-open')));
    on('#sidebarBack', 'click', () => setPanels(false));
    on('#btnSelAll', 'click', () => this.selectAll());
    on('#btnDeselect', 'click', () => this.clearSelection());
    on('#btnClearSel', 'click', () => this.clearSelectedPixels());

    // canvas pointer events
    const sc = this.scroll;
    sc.addEventListener('pointerdown', e => this.onDown(e));
    sc.addEventListener('pointermove', e => this.onMove(e));
    sc.addEventListener('pointerup', e => this.onUp(e));
    sc.addEventListener('pointercancel', e => this.onUp(e));
    sc.addEventListener('pointerleave', () => { this.hover = null; this.renderOverlay(); });
    // a finger lifted outside the canvas must not count as still touching
    for (const type of ['pointerup', 'pointercancel']) {
      window.addEventListener(type, e => {
        if (e.pointerType !== 'touch' || !this.touches?.delete(e.pointerId)) return;
        if (!this.touches.size && this.gesture) this.endGesture();
      });
    }
    sc.addEventListener('contextmenu', e => e.preventDefault());
    sc.addEventListener('wheel', e => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      this.zoomStep(e.deltaY < 0 ? 1 : -1, e);
    }, { passive: false });

    // captions
    on('#capText', 'input', e => this.editCaption('text', e.target.value));
    on('#capSize', 'input', e => +e.target.value > 0 && this.editCaption('size', +e.target.value));
    on('#capFont', 'change', e => this.editCaption('font', e.target.value));
    on('#capColor', 'input', e => this.editCaption('color', e.target.value));
    on('#capOutline', 'input', e => this.editCaption('outline', e.target.value));
    on('#capBox', 'input', e => this.editCaption('box', e.target.value));
    on('#capBoxAlpha', 'input', e => this.editCaption('boxAlpha', +e.target.value / 100));
    on('#capAlign', 'change', e => this.editCaption('align', e.target.value));
    on('#capBold', 'change', e => this.editCaption('bold', e.target.checked));
    for (const id of ['#capText', '#capSize', '#capColor', '#capOutline', '#capBox', '#capBoxAlpha']) {
      on(id, 'change', () => (this.capEditPushed = false));
    }
    for (const id of ['#capFont', '#capAlign', '#capBold']) on(id, 'change', () => (this.capEditPushed = false));
    $$('#capAnchor button').forEach(b => b.addEventListener('click', () => {
      this.capEditPushed = false;
      this.editCaption('anchor', b.dataset.anchor || null);
      this.capEditPushed = false;
    }));
    on('#capMargin', 'input', e => e.target.value !== '' && +e.target.value >= 0 && this.editCaption('margin', +e.target.value));
    on('#capMargin', 'change', () => (this.capEditPushed = false));
    on('#capStyleAll', 'click', () => this.applyCaptionStyleAll());
    on('#capDelete', 'click', () => this.deleteCaption());
    on('#capToNext', 'click', () => this.captionToNextFrame());

    // layers
    on('#btnAddLayer', 'click', () => this.addLayer('raster'));
    on('#btnAddCaptionLayer', 'click', () => this.addLayer('caption'));
    on('#btnDelLayer', 'click', () => this.deleteLayer());
    on('#btnLayerUp', 'click', () => this.moveLayer(1));
    on('#btnLayerDown', 'click', () => this.moveLayer(-1));
    on('#btnDupLayer', 'click', () => this.duplicateLayer());
    on('#btnMergeDown', 'click', () => this.mergeDown());
    on('#layerOpInput', 'input', e => {
      this.layer.opacity = +e.target.value / 100;
      $('#layerOpOut').textContent = e.target.value + '%';
      this.setDirty(true);
      this.render();
      this.scheduleThumb(this.frame);
    });

    // frames
    on('#btnAddFrame', 'click', () => this.addFrame());
    on('#btnDupFrame', 'click', () => this.duplicateFrame());
    on('#btnDelFrame', 'click', () => this.deleteFrame());
    on('#btnFrameLeft', 'click', () => this.moveFrameTo(this.cur, this.cur - 1));
    on('#btnFrameRight', 'click', () => this.moveFrameTo(this.cur, this.cur + 1));
    on('#frameDur', 'change', e => this.setDuration(+e.target.value));
    on('#btnDurAll', 'click', () => this.setDuration(+$('#frameDur').value, true));

    // quick caption box: type the current frame's caption; Enter moves to the next frame
    on('#frameCaption', 'focus', () => { const p = this.primaryCaption(); if (p) this.selectCaption(p.layer.id, p.cap.id); });
    on('#frameCaption', 'input', e => this.quickCaptionInput(e.target.value));
    on('#frameCaption', 'blur', () => this.quickCaptionDone());
    on('#frameCaption', 'keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      this.quickCaptionDone();
      const i = this.cur + (e.shiftKey ? -1 : 1);
      if (i < 0 || i >= this.frames.length) { e.target.blur(); return; }
      this.goto(i);
      const p = this.primaryCaption();
      e.target.value = p?.cap.text ?? '';
      e.target.select();
      if (p) this.selectCaption(p.layer.id, p.cap.id);
    });

    // clipboard + drag & drop from other apps
    window.addEventListener('paste', e => this.onPaste(e));
    sc.addEventListener('dragover', e => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      sc.classList.add('drop-target');
    });
    sc.addEventListener('dragleave', () => sc.classList.remove('drop-target'));
    sc.addEventListener('drop', e => {
      sc.classList.remove('drop-target');
      const files = [...(e.dataTransfer?.files || [])];
      if (!files.length) return;
      e.preventDefault();
      const img = files.find(f => f.type.startsWith('image/'));
      const aud = files.find(isAudioFile);
      if (img) this.pasteImageFile(img);
      else if (aud) this.importAudioFile(aud);
      else toast('Drop an image or an audio file.', true);
    });
    const ab = $('#audioPanel');
    ab.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
    ab.addEventListener('drop', e => {
      const f = [...(e.dataTransfer?.files || [])].find(isAudioFile);
      if (!f) return;
      e.preventDefault();
      this.importAudioFile(f);
    });

    // audio
    let collapsed = false;
    try {
      const v = localStorage.getItem('fs.audioCollapsed');
      collapsed = v === null ? matchMedia('(max-width: 760px)').matches : v === '1';
    } catch { /* storage blocked */ }
    ab.classList.toggle('collapsed', collapsed);
    on('#btnAudioToggle', 'click', () => {
      const c = ab.classList.toggle('collapsed');
      try { localStorage.setItem('fs.audioCollapsed', c ? '1' : '0'); } catch { /* storage blocked */ }
      if (!c) { this.trackView.draw(); this.wave.draw(); }
    });
    on('#btnAddTrack', 'click', () => this.addTrack());
    on('#btnImportAudio', 'click', () => $('#audioFile').click());
    on('#audioFile', 'change', e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) this.importAudioFile(f);
    });
    on('#clipTrim', 'change', e => {
      const c = this.clip;
      if (!c) return;
      this.pushUndo(this.snapTracks());
      this.clip.trim = e.target.checked;
      this.setDirty(true);
      this.refreshAudio();
    });
    on('#btnRecord', 'click', () => this.toggleRecord());
    on('#btnAudioPlay', 'click', () => (this.preview ? this.stopPreview() : this.playAudio(false)));
    on('#btnAudioPlaySel', 'click', () => this.playAudio(true));
    on('#btnAudioSplit', 'click', () => this.splitAtCursor());
    on('#btnAudioKeep', 'click', () => this.editAudio(A.keepRange));
    on('#btnAudioCut', 'click', () => this.editAudio(A.cutRange));
    on('#btnAudioSilence', 'click', () => this.editAudio(A.silenceRange));
    on('#btnAudioNormalize', 'click', () => this.editAudio(a => A.normalize(a), false));
    on('#btnAudioDelete', 'click', () => this.deleteAudio());
    on('#btnAudioFit', 'click', () => {
      const c = this.clip;
      if (c && c.frameId === this.frame.id) this.setDuration(Math.max(0.04, Math.round((c.offset + A.duration(c.audio)) * 100) / 100));
    });
    on('#audioGain', 'input', e => {
      const c = this.clip;
      if (!c) return;
      if (!this.gainPushed) { this.pushUndo(this.snapTracks()); this.gainPushed = true; }
      c.audio = { ...c.audio, gain: +e.target.value / 100 };
      $('#audioGainOut').textContent = e.target.value + '%';
      this.wave.set(c.audio, this.wave.frameDur);
      this.trackView.draw();
      this.setDirty(true);
    });
    on('#audioGain', 'change', () => (this.gainPushed = false));

    // keyboard
    window.addEventListener('pointerdown', e => { this.audioFocus = !!e.target.closest?.('#audioPanel'); }, true);
    window.addEventListener('keydown', e => this.onKey(e));
    window.addEventListener('keyup', e => { if (e.code === 'Space') this.spaceHeld = false; });
    window.addEventListener('resize', () => this.renderOverlay());
  }

  onKey(e) {
    if ($('#editor').hidden || isModalOpen()) return;
    const t = e.target;
    const typing = t.matches?.('textarea, select, input[type=text], input[type=number]');
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();

    if (mod && k === 's') { e.preventDefault(); e.shiftKey ? this.saveAs() : this.save(); return; }
    if (typing) { if (e.key === 'Escape') t.blur(); return; }

    if (mod) {
      const acts = {
        z: () => (e.shiftKey ? this.redo() : this.undo()), y: () => this.redo(),
        a: () => this.selectAll(), d: () => this.clearSelection(),
        c: () => (this.audioFocus && this.clip ? this.copyClip(false) : e.shiftKey ? this.copyMerged() : this.copy(false)),
        x: () => (this.audioFocus && this.clip ? this.copyClip(true) : this.copy(true)),
        // Ctrl+V is left to the 'paste' event so the system clipboard (images, audio, text) works too
        '=': () => this.zoomStep(1), '+': () => this.zoomStep(1), '-': () => this.zoomStep(-1), '0': () => this.fit(),
      };
      if (acts[k]) { e.preventDefault(); acts[k](); }
      return;
    }
    if (this.playing && e.code !== 'Space') return;

    if (e.shiftKey && (k === 'h' || k === 'v')) { this.flip(k); return; }
    if (TOOL_KEYS[k]) { this.setTool(TOOL_KEYS[k]); return; }
    const nudge = e.shiftKey ? 10 : 1;
    const canNudge = this.tool === 'move' && this.layer.type === 'raster' && (this.floating || this.selection);
    switch (e.key) {
      case ' ':
        e.preventDefault();
        if (t instanceof HTMLButtonElement) t.blur();
        if (e.repeat) return;
        this.play();
        break;
      case '[': this.setSize(this.size - Math.max(1, Math.round(this.size * 0.15))); break;
      case ']': this.setSize(this.size + Math.max(1, Math.round(this.size * 0.15))); break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        if (this.audioFocus && this.clip) this.deleteAudio();
        else if (this.selCaption) this.deleteCaption(); else this.clearSelectedPixels();
        break;
      case 'Escape':
        if (this.splitMode) this.setSplitMode(false);
        else if (this.selCaption) this.selectCaption(null); else this.clearSelection();
        break;
      case 'Enter': this.commitFloating(); break;
      case '?': this.showShortcuts(); break;
      case 's': case 'S': if (this.audioFocus || this.splitMode) this.splitAtCursor(); break;
      case 'ArrowLeft': e.preventDefault(); canNudge ? this.nudge(-nudge, 0) : this.goto(this.cur - 1); break;
      case 'ArrowRight': e.preventDefault(); canNudge ? this.nudge(nudge, 0) : this.goto(this.cur + 1); break;
      case 'ArrowUp': if (canNudge) { e.preventDefault(); this.nudge(0, -nudge); } break;
      case 'ArrowDown': if (canNudge) { e.preventDefault(); this.nudge(0, nudge); } break;
      case ',': this.goto(this.cur - 1); break;
      case '.': this.goto(this.cur + 1); break;
      case 'r': this.toggleRecord(); break;
      case 'h': this.spaceHeld = !this.spaceHeld; toast(this.spaceHeld ? 'Hand (pan) mode on — press H to turn off' : 'Hand mode off'); break;
    }
  }

  setSize(v) {
    this.size = clamp(v, 1, 300);
    $('#sizeInput').value = this.size;
    $('#sizeOut').textContent = this.size;
    this.syncQuickBar();
    this.renderOverlay();
  }

  /** The floating bar on phones: undo / redo, frame stepping, brush size and color. */
  syncQuickBar() {
    if (!this.frames?.length) return;
    $('#qbFrame').textContent = `${this.cur + 1}/${this.frames.length}`;
    $('#qbPrev').disabled = this.cur === 0;
    $('#qbNext').disabled = this.cur === this.frames.length - 1;
    $('#qbColor').style.background = this.color;
    const sized = this.tool === 'brush' || this.tool === 'eraser';
    $('#qbSizeWrap').hidden = !sized;
    if (sized) $('#qbSize').value = Math.round(Math.sqrt((this.size - 1) / 299) * 100); // finer control for small sizes
    $('#qbUndo').disabled = !this.undoStack?.length;
    $('#qbRedo').disabled = !this.redoStack?.length;
  }

  showShortcuts() {
    const rows = [
      ['B / E / G / I', 'Brush / eraser / fill / eyedropper'], ['M / L / V / T', 'Rect / lasso / move / caption'],
      ['[ / ]', 'Brush size'], ['Alt+click', 'Pick a color while painting'],
      ['Ctrl+Z / Ctrl+Y', 'Undo / redo'], ['Ctrl+S', 'Save (Ctrl+Shift+S: save as new)'],
      ['Ctrl+A / Ctrl+D', 'Select all / deselect'], ['Ctrl+C / X / V', 'Copy / cut / paste'],
      ['Ctrl+Shift+C', 'Copy everything visible'], ['Shift+H / Shift+V', 'Flip horizontally / vertically'],
      ['Enter', 'Drop moved pixels'], ['Delete', 'Clear selection, caption or clip'],
      ['← → or , .', 'Previous / next frame'], ['Space', 'Play / stop'], ['H', 'Hand (pan) mode'],
      ['Ctrl+wheel', 'Zoom'], ['R', 'Record'], ['S', 'Split audio clip'], ['?', 'This list'],
      ['Touch', 'One finger draws · two fingers pinch / pan · two-finger tap undoes · three-finger tap redoes'],
    ];
    sheet({
      title: 'Shortcuts',
      body: [el('table', { class: 'shortcuts' }, ...rows.map(([k, v]) => el('tr', {}, el('td', {}, el('kbd', { textContent: k })), el('td', { textContent: v }))))],
      buttons: [],
    });
  }

  /** Fingers draw unless a pen has been used (then fingers only pan and zoom). Saved per device. */
  get fingerDraws() { return $('#fingerDrawInput').checked; }
}

const isAudioFile = f => f.type.startsWith('audio/') || /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|webm)$/i.test(f.name);

// ---------------------------------------------------------------------
// clipboard image signature: recognises our own copy coming back from the system clipboard
// ---------------------------------------------------------------------
const SIG_N = 8;
function sigSamples(src, w, h) {
  const c = makeCanvas(w, h);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(src, 0, 0);
  const d = g.getImageData(0, 0, w, h).data;
  const out = [];
  for (let j = 0; j < SIG_N; j++) {
    for (let i = 0; i < SIG_N; i++) {
      const x = Math.floor((i + 0.5) * w / SIG_N), y = Math.floor((j + 0.5) * h / SIG_N);
      const o = (y * w + x) * 4;
      out.push(d[o], d[o + 1], d[o + 2], d[o + 3]);
    }
  }
  return out;
}
function imageSig(canvas) {
  return { w: canvas.width, h: canvas.height, px: sigSamples(canvas, canvas.width, canvas.height) };
}
function sigMatches(sig, bmp) {
  if (bmp.width !== sig.w || bmp.height !== sig.h) return false;
  const px = sigSamples(bmp, bmp.width, bmp.height);
  for (let i = 0; i < px.length; i += 4) {
    if (Math.abs(px[i + 3] - sig.px[i + 3]) > 8) return false;
    if (sig.px[i + 3] > 200) { // colour only means something where the pixel is (nearly) opaque
      for (let k = 0; k < 3; k++) if (Math.abs(px[i + k] - sig.px[i + k]) > 8) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------
// text wrapping
// ---------------------------------------------------------------------
function wrapText(m, text, maxW) {
  const out = [];
  for (const para of text.split('\n')) {
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const next = line + w;
      if (line.trim() && m.measureText(next.trimEnd()).width > maxW) {
        out.push(line.trimEnd());
        line = w.trimStart();
      } else {
        line = next;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

// ---------------------------------------------------------------------
// flood fill helpers
// ---------------------------------------------------------------------
function floodMask(img, sx, sy, tol) {
  const { width: W, height: H, data } = img;
  const mask = new Uint8Array(W * H);
  const o0 = (sy * W + sx) * 4;
  const tr = data[o0], tg = data[o0 + 1], tb = data[o0 + 2], ta = data[o0 + 3];
  const match = i => {
    const o = i * 4;
    // Fully transparent pixels match each other regardless of their (meaningless) RGB.
    if (ta === 0 && data[o + 3] <= tol) return true;
    return Math.abs(data[o] - tr) <= tol && Math.abs(data[o + 1] - tg) <= tol &&
      Math.abs(data[o + 2] - tb) <= tol && Math.abs(data[o + 3] - ta) <= tol;
  };
  const stack = [sx, sy];
  while (stack.length) {
    const y = stack.pop();
    let x = stack.pop();
    let i = y * W + x;
    while (x >= 0 && !mask[i] && match(i)) { x--; i--; }
    x++; i++;
    let up = false, down = false;
    while (x < W && !mask[i] && match(i)) {
      mask[i] = 1;
      if (y > 0) {
        const j = i - W;
        if (!mask[j] && match(j)) { if (!up) { stack.push(x, y - 1); up = true; } } else up = false;
      }
      if (y < H - 1) {
        const j = i + W;
        if (!mask[j] && match(j)) { if (!down) { stack.push(x, y + 1); down = true; } } else down = false;
      }
      x++; i++;
    }
  }
  return mask;
}

function dilate(mask, W, H) {
  const out = mask.slice();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (mask[i]) continue;
      if ((x > 0 && mask[i - 1]) || (x < W - 1 && mask[i + 1]) || (y > 0 && mask[i - W]) || (y < H - 1 && mask[i + W])) out[i] = 1;
    }
  }
  return out;
}
