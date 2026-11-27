"""FrameSketch local server.

Serves the web app from ./app and stores projects on disk under ./data
(override with the FRAMESKETCH_DATA environment variable).

No third-party dependencies: run with `py server.py` (Windows) or
`python3 server.py` (macOS/Linux), then open http://localhost:8765
"""

import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
APP_DIR = ROOT / "app"
DATA_DIR = Path(os.environ.get("FRAMESKETCH_DATA", ROOT / "data")).resolve()
PROJECTS_DIR = DATA_DIR / "projects"
PORT = int(os.environ.get("FRAMESKETCH_PORT", "8765"))
ID_RE = re.compile(r"^[a-z0-9]{6,40}$")
MAX_BODY = 1024 * 1024 * 1024  # 1 GB
EXPORTS_DIR = DATA_DIR / "exports"
KEEP_EXPORTS = 10


def copy_file_to_clipboard(path):
    """Put a file on the OS clipboard the way a file manager's Copy does, so apps like
    Discord upload it on paste. Returns None on success or an error message."""
    path = str(path)
    try:
        if sys.platform == "win32":
            script = (
                "Add-Type -AssemblyName System.Windows.Forms;"
                "$c = New-Object System.Collections.Specialized.StringCollection;"
                "[void]$c.Add($env:FS_CLIP_FILE);"
                "[System.Windows.Forms.Clipboard]::SetFileDropList($c)"
            )
            r = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-STA", "-Command", script],
                env={**os.environ, "FS_CLIP_FILE": path}, capture_output=True, text=True, timeout=20,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        elif sys.platform == "darwin":
            r = subprocess.run(
                ["osascript", "-e", "on run argv", "-e", "set the clipboard to (POSIX file (item 1 of argv))",
                 "-e", "end run", path],
                capture_output=True, text=True, timeout=20,
            )
        else:
            uri = Path(path).as_uri() + "\n"
            if shutil.which("wl-copy") and os.environ.get("WAYLAND_DISPLAY"):
                cmd = ["wl-copy", "--type", "text/uri-list"]
            elif shutil.which("xclip"):
                cmd = ["xclip", "-selection", "clipboard", "-t", "text/uri-list", "-i"]
            else:
                return "install xclip or wl-clipboard to copy files to the clipboard"
            # xclip / wl-copy keep running to serve the clipboard, so don't wait for them
            proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            proc.stdin.write(uri.encode())
            proc.stdin.close()
            return None
        if r.returncode != 0:
            return (r.stderr or r.stdout or "clipboard command failed").strip()[:300]
        return None
    except (OSError, subprocess.SubprocessError) as e:
        return str(e)


def now_ms():
    return int(time.time() * 1000)


def new_id():
    return uuid.uuid4().hex[:16]


def read_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"))
    os.replace(tmp, path)


def project_dir(pid):
    if not ID_RE.match(pid):
        raise ApiError(HTTPStatus.BAD_REQUEST, "bad project id")
    d = PROJECTS_DIR / pid
    if not (d / "project.json").exists():
        raise ApiError(HTTPStatus.NOT_FOUND, "project not found")
    return d


def save_path(pid, sid):
    if not ID_RE.match(sid):
        raise ApiError(HTTPStatus.BAD_REQUEST, "bad save id")
    p = project_dir(pid) / "saves" / f"{sid}.json"
    if not p.exists():
        raise ApiError(HTTPStatus.NOT_FOUND, "save not found")
    return p


def save_meta(path):
    """Read a save's metadata without returning its (large) document."""
    s = read_json(path)
    return {k: s.get(k) for k in ("id", "name", "created", "updated", "frames")}


def project_summary(pid):
    d = PROJECTS_DIR / pid
    meta = read_json(d / "project.json")
    saves = []
    sd = d / "saves"
    if sd.exists():
        for f in sd.glob("*.json"):
            try:
                saves.append(save_meta(f))
            except (OSError, ValueError):
                pass
    saves.sort(key=lambda s: s.get("updated") or 0, reverse=True)
    meta["saves"] = saves
    return meta


def touch_project(pid):
    p = PROJECTS_DIR / pid / "project.json"
    meta = read_json(p)
    meta["updated"] = now_ms()
    write_json(p, meta)


def write_save(pid, sid, name, doc, created=None):
    t = now_ms()
    obj = {
        "id": sid,
        "name": name,
        "created": created or t,
        "updated": t,
        "frames": len(doc.get("frames", [])) if isinstance(doc, dict) else 0,
        "doc": doc,
    }
    write_json(PROJECTS_DIR / pid / "saves" / f"{sid}.json", obj)
    touch_project(pid)
    return {k: obj[k] for k in ("id", "name", "created", "updated", "frames")}


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class Handler(SimpleHTTPRequestHandler):
    # Windows registry MIME types can be wrong (e.g. .js as text/plain),
    # which breaks ES modules, so pin the ones the app uses.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".json": "application/json",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    def log_message(self, fmt, *args):
        if "/api/" in (self.path or ""):
            sys.stderr.write("%s %s\n" % (self.command, self.path))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # ---- helpers -------------------------------------------------------
    def send_json(self, obj, status=HTTPStatus.OK):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "too large")
        if n == 0:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except ValueError:
            raise ApiError(HTTPStatus.BAD_REQUEST, "invalid json")

    def handle_api(self, method):
        parts = [p for p in urlparse(self.path).path.split("/") if p][1:]
        try:
            result = self.route(method, parts)
            self.send_json(result if result is not None else {"ok": True})
        except ApiError as e:
            self.send_json({"error": e.message}, e.status)
        except Exception as e:  # noqa: BLE001
            self.send_json({"error": str(e)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    # ---- routes --------------------------------------------------------
    def export_file(self):
        """POST /api/export?name=<file name>, body = raw file bytes. Saves it under data/exports
        and puts it on the system clipboard as a file."""
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BODY:
            raise ApiError(HTTPStatus.BAD_REQUEST, "empty or too large")
        q = parse_qs(urlparse(self.path).query)
        raw = (q.get("name") or ["FrameSketch.mp4"])[0]
        name = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", raw).strip(" .")[:120] or "FrameSketch.mp4"
        if not re.search(r"\.(mp4|webm)$", name, re.I):
            raise ApiError(HTTPStatus.BAD_REQUEST, "only .mp4 / .webm exports")
        EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
        dest = EXPORTS_DIR / name
        data = self.rfile.read(n)
        dest.write_bytes(data)
        # Browser recordings have no duration in the header; if ffmpeg is installed, remux
        # (no re-encode) so players show the length and can seek right away.
        if dest.suffix.lower() == ".mp4" and shutil.which("ffmpeg"):
            tmp = dest.with_name(dest.stem + ".remux.mp4")
            try:
                r = subprocess.run(
                    ["ffmpeg", "-y", "-loglevel", "error", "-i", str(dest), "-c", "copy", "-movflags", "+faststart", str(tmp)],
                    capture_output=True, timeout=120, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                if r.returncode == 0 and tmp.exists() and tmp.stat().st_size > 0:
                    os.replace(tmp, dest)
            except (OSError, subprocess.SubprocessError):
                pass
            finally:
                if tmp.exists():
                    tmp.unlink()
            data = dest.read_bytes()
        # keep only the newest few exports
        old = sorted((f for f in EXPORTS_DIR.iterdir() if f.is_file()), key=lambda f: f.stat().st_mtime, reverse=True)
        for f in old[KEEP_EXPORTS:]:
            try:
                f.unlink()
            except OSError:
                pass
        err = copy_file_to_clipboard(dest)
        return {"path": str(dest), "size": len(data), "copied": err is None, "error": err}

    def route(self, method, parts):
        n = len(parts)
        if parts == ["export"] and method == "POST":
            return self.export_file()
        if n == 0 or parts[0] != "projects":
            raise ApiError(HTTPStatus.NOT_FOUND, "unknown endpoint")

        # /api/projects
        if n == 1:
            if method == "GET":
                PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
                out = []
                for d in PROJECTS_DIR.iterdir():
                    if (d / "project.json").exists():
                        try:
                            out.append(project_summary(d.name))
                        except (OSError, ValueError):
                            pass
                out.sort(key=lambda p: p.get("updated") or 0, reverse=True)
                return out
            if method == "POST":
                b = self.body()
                pid = new_id()
                t = now_ms()
                meta = {
                    "id": pid,
                    "name": str(b.get("name") or "Untitled project")[:120],
                    "created": t,
                    "updated": t,
                }
                for k in ("width", "height", "background"):
                    if k in b:
                        meta[k] = b[k]
                write_json(PROJECTS_DIR / pid / "project.json", meta)
                if isinstance(b.get("doc"), dict):
                    write_save(pid, new_id(), "Save 1", b["doc"])
                return project_summary(pid)

        pid = parts[1]

        # /api/projects/:pid
        if n == 2:
            d = project_dir(pid)
            if method == "GET":
                return project_summary(pid)
            if method == "PATCH":
                b = self.body()
                meta = read_json(d / "project.json")
                if "name" in b:
                    meta["name"] = str(b["name"])[:120]
                meta["updated"] = now_ms()
                write_json(d / "project.json", meta)
                return project_summary(pid)
            if method == "DELETE":
                shutil.rmtree(d)
                return None

        # /api/projects/:pid/duplicate
        if n == 3 and parts[2] == "duplicate" and method == "POST":
            d = project_dir(pid)
            nid = new_id()
            shutil.copytree(d, PROJECTS_DIR / nid)
            meta = read_json(PROJECTS_DIR / nid / "project.json")
            t = now_ms()
            meta.update(id=nid, name=meta.get("name", "Project") + " (copy)", created=t, updated=t)
            write_json(PROJECTS_DIR / nid / "project.json", meta)
            return project_summary(nid)

        # /api/projects/:pid/saves
        if n == 3 and parts[2] == "saves" and method == "POST":
            project_dir(pid)
            b = self.body()
            if not isinstance(b.get("doc"), dict):
                raise ApiError(HTTPStatus.BAD_REQUEST, "missing doc")
            return write_save(pid, new_id(), str(b.get("name") or "Save")[:120], b["doc"])

        # /api/projects/:pid/saves/:sid
        if n == 4 and parts[2] == "saves":
            p = save_path(pid, parts[3])
            if method == "GET":
                return read_json(p)
            if method == "PUT":
                b = self.body()
                old = read_json(p)
                doc = b["doc"] if isinstance(b.get("doc"), dict) else old.get("doc", {})
                name = str(b.get("name") or old.get("name") or "Save")[:120]
                return write_save(pid, parts[3], name, doc, created=old.get("created"))
            if method == "PATCH":
                b = self.body()
                old = read_json(p)
                if "name" in b:
                    old["name"] = str(b["name"])[:120]
                old["updated"] = now_ms()
                write_json(p, old)
                touch_project(pid)
                return save_meta(p)
            if method == "DELETE":
                p.unlink()
                touch_project(pid)
                return None

        # /api/projects/:pid/saves/:sid/duplicate
        if n == 5 and parts[2] == "saves" and parts[4] == "duplicate" and method == "POST":
            old = read_json(save_path(pid, parts[3]))
            return write_save(pid, new_id(), (old.get("name") or "Save") + " (copy)", old.get("doc", {}))

        raise ApiError(HTTPStatus.NOT_FOUND, "unknown endpoint")

    # ---- verbs ---------------------------------------------------------
    def do_GET(self):
        if self.path.startswith("/api/"):
            return self.handle_api("GET")
        return super().do_GET()

    def do_POST(self):
        self.handle_api("POST")

    def do_PUT(self):
        self.handle_api("PUT")

    def do_PATCH(self):
        self.handle_api("PATCH")

    def do_DELETE(self):
        self.handle_api("DELETE")


def main():
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = f"http://localhost:{PORT}"
    print(f"FrameSketch running at {url}")
    print(f"Projects stored in {PROJECTS_DIR}")
    print("Press Ctrl+C to stop.")
    if "--no-browser" not in sys.argv:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
