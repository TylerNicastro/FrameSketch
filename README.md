# FrameSketch

A local app for drawing concept art frame by frame, timing each frame, recording
voice-over per frame from your microphone, and adding captions.

No build step and no dependencies beyond Python 3.

## Run

- **Windows:** double-click `start.bat` (or run `py server.py`)
- **macOS / Linux:** `./start.sh` (or `python3 server.py`)

Your browser opens at <http://localhost:8765>. Options:

| Env var             | Default  | Purpose                          |
| ------------------- | -------- | -------------------------------- |
| `FRAMESKETCH_PORT`  | `8765`   | Port to serve on                 |
| `FRAMESKETCH_DATA`  | `./data` | Folder where projects are stored |

Pass `--no-browser` to skip opening a browser tab.

## Features

**Projects & saves** – many projects, each with many saves. Open, rename,
duplicate and delete both projects and saves from the home screen. In the editor,
*Save* (Ctrl+S) overwrites the current save and *Save as new* (Ctrl+Shift+S)
creates another save in the same project.

**Drawing**
- Layers: add, delete, reorder, rename (double-click), hide, opacity, duplicate, merge down.
  The layer stack is shared by every frame; each frame has its own drawing on each layer.
- Brush and eraser with size, opacity, smoothing and pen pressure. Brush and eraser keep separate
  sizes, a pen's eraser tip always erases, and painting while a caption layer is active switches
  back to your last drawing layer.
- Color picker, hex entry, palette, recent colors and an eyedropper (Alt+click while painting).
- Fill bucket with tolerance, "sample all layers" and 1px grow to close line-art gaps.
- Rectangle and lasso selection. Painting and filling stay inside the selection.
- Move tool for the selection, or the whole layer when nothing is selected. Copy / cut / paste.
- Ctrl+click or Shift+click layers in the layer list to select several. Ctrl+C then copies them
  merged (inside the selection, if any) and Ctrl+X clears them all in one undo step.
  Ctrl+Shift+C copies the whole visible frame, captions included.
- Flip H / Flip V (Shift+H / Shift+V) mirror the selection in place, or the whole layer when
  nothing is selected. The result stays movable until you press Enter.
- Paste from the system clipboard (Ctrl+V): images from other apps land centered (scaled to fit)
  as a movable selection, audio files are imported, and text becomes a caption. Copy (Ctrl+C) also
  puts the selection on the system clipboard as a PNG. Images and audio can be dropped onto the canvas too.
- Undo / redo, zoom, pan, onion skin and PNG export of the current frame.
- **Copy video** records the whole scene with all audio tracks as an MP4 (H.264 + AAC; WebM if the
  browser can't make MP4) and puts the file on the system clipboard, so Ctrl+V in Discord (or
  Explorer / Finder) uploads it as a video. In Chrome / Edge it is encoded directly (WebCodecs):
  each drawing is encoded once and held for its duration, so it takes seconds, not the scene's
  length. Other browsers fall back to recording in real time (keep the tab open). Click the button
  again to cancel. Shift+click saves the file instead. The bitrate aims to stay under
  Discord's 10 MB limit. Copies are kept in `data/exports/` (the newest 10). Copying a file to the
  clipboard uses PowerShell on Windows, `osascript` on macOS and `xclip` / `wl-copy` on Linux. If
  that fails, the video is downloaded instead. If `ffmpeg` is installed, the file is remuxed so
  players show its length right away.

**Frames & timing** – add, duplicate, delete and reorder frames (drag the thumbnails),
set each frame's time in seconds or apply one time to all, and play back with looping. The **Speed %** box
next to Loop plays the whole scene faster or slower for testing (audio pitch changes with it); it
isn't saved and doesn't affect exports.

**Audio tracks** – any number of tracks (rename by double-clicking, mute, volume). A clip
starts on a frame and keeps playing across the following frames until it ends, until the next
clip on the same track starts, or, with *Stop at frame end*, when its frame ends. Record from the
microphone or *Import audio…* (mp3, wav, ogg, m4a, …, or paste / drop a file) onto the selected
track at the current frame. Drag clips in the track view to move them in time or onto another
track (they snap to frame starts); click the ruler to jump to a frame. On the waveform, drag to
select and *Clip to selection*, *Cut selection*, *Silence*, *Normalize*, adjust gain, or
*Fit frame to clip*. To split a clip, press *Split* (or S) and click the clip in the tracks or on
the waveform where it should be cut; split points snap to frame edges when close (the line turns
yellow), and Esc cancels. Alt+click in the tracks splits right away. If a point is already marked on
the waveform, *Split* cuts there; with a region selected, it cuts at both edges. Each part is then
its own clip you can drag separately. After clicking in the audio panel, Ctrl+C / Ctrl+X copy
or cut the selected clip (or just the selected region) and Ctrl+V pastes it at the current frame;
Delete removes the clip. Saves from older versions turn per-frame audio into a "Voice" track whose
clips stop at their frame's end, so they sound the same.

**Captions** – caption layers are their own layer type. A frame's first caption is centered at
the bottom by default and long text wraps. The quickest way to caption is the **Caption** box in
the frames bar: type, then press Enter to move to the next frame (Shift+Enter goes back). With the
Caption tool (T), click to add a caption, click one to edit its text, font, size, colors, outline,
box, alignment and position (Top / Middle / Bottom / Free, plus margin), and drag to move it.
Dragging it near the top, middle or bottom spot snaps it back. New captions use the last style
you picked. A Free caption shows handles on its box: drag them to resize the box, and the text
re-wraps to the new width and stays centered inside (*Auto size* fits the box to the text again).
*Apply style to all frames* gives every caption on the layer the same look and spot;
*Copy to next frame* carries a caption forward.

## Shortcuts

| Key | Action | Key | Action |
| --- | --- | --- | --- |
| B / E / G / I | Brush / Eraser / Fill / Eyedropper | Space | Play / stop |
| M / L / V / T | Rect / Lasso / Move / Caption | ← → or , . | Previous / next frame |
| [ / ] | Brush size | R | Record / stop |
| Ctrl+Z / Ctrl+Y | Undo / redo | Ctrl+S | Save |
| Ctrl+A / Ctrl+D | Select all / deselect | Delete | Clear selection or caption |
| Ctrl+C / X / V | Copy / cut / paste (incl. system clipboard) | Enter | Commit a move |
| Ctrl+wheel | Zoom | Middle-drag or H | Pan |
| Shift+H / Shift+V | Flip selection (or layer) horizontally / vertically | S | Split audio clip |

## Storage & git

Projects are saved to `data/projects/<project-id>/` as `project.json` plus one
JSON file per save (drawings embedded as PNG, audio as WAV). `data/` is in
`.gitignore` so the repository tracks only the app; remove that line if you
want to commit your artwork too (Git LFS is a good fit for large saves).

## Layout

```
server.py        Python HTTP server + JSON API for projects/saves
app/index.html   UI markup
app/styles.css   Styles
app/js/main.js   Project manager (home screen)
app/js/editor.js Drawing, layers, frames, captions, playback
app/js/audio.js  Mic recording, audio import, WAV encode/decode, playback, waveform editor
app/js/tracks.js Multi-track audio view
app/js/api.js    API client
app/js/util.js   DOM helpers, modals, toasts
```
