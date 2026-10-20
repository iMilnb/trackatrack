#!/usr/bin/env python3
"""Trackatrack dev server: static app + /api/tracks + /api/config + /audio/<path> (Range support)."""
import argparse
import json
import os
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import unquote, quote

APP_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_FILE = os.path.join(APP_DIR, ".library-cache-v2.json")
AUDIO_EXTS = {".mp3", ".wav", ".flac", ".ogg", ".oga", ".m4a", ".aac", ".opus"}

CFG = {"music_dir": os.path.expanduser("~/Music"), "cache": None}
MEDIA_TYPES = {
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac",
    ".ogg": "audio/ogg", ".oga": "audio/ogg", ".m4a": "audio/mp4",
    ".aac": "audio/aac", ".opus": "audio/ogg",
}


def read_tags(path, fallback_title):
    """Best-effort tag read via mutagen; never raises."""
    t = {"title": fallback_title, "artist": "", "album": "", "bpm": None, "key": "", "genre": "", "duration": None}
    try:
        from mutagen import File as MFile
        f = MFile(path)
    except Exception:
        return t
    if f is None:
        return t
    try:
        if getattr(f, "length", None):
            t["duration"] = round(f.length, 2)
        elif getattr(f, "info", None) and getattr(f.info, "bitrate", None):
            size = os.path.getsize(path)
            t["duration"] = round(size * 8.0 / f.info.bitrate, 2)
    except Exception:
        pass
    try:
        tags = f.tags or {}
        def first(*keys):
            for k in keys:
                try:
                    v = tags.get(k)
                    if v is None:
                        continue
                    v = v[0] if isinstance(v, list) else v
                    s = str(v).strip()
                    if s:
                        return s
                except Exception:
                    continue
            return None
        # mp3/ID3 text frames + generic keys (vorbis)
        t["title"] = first("TIT2", "title", "TITLE") or t["title"]
        t["artist"] = first("TPE1", "TPE2", "artist", "ARTIST") or t["artist"]
        t["album"] = first("TALB", "album", "ALBUM") or t["album"]
        bpm = first("TBPM", "bpm", "BPM")
        if bpm:
            try:
                bpmf = float(bpm)
                if 40 <= bpmf <= 300:
                    t["bpm"] = bpmf
            except ValueError:
                pass
        t["key"] = first("TKEY", "initial_key", "key", "KEY") or t["key"]
        genre = first("TCON", "genre", "GENRE")
        if genre:
            g = genre.strip()
            if g.startswith("(") and ")" in g:  # ID3 numeric genre like "(17)Electronica"
                g = g.split(")", 1)[1].strip()
            t["genre"] = g
    except Exception:
        pass
    return t


def scan_tracks(music_dir):
    """Walk music dir, return list of track dicts. Uses mutagen when available."""
    tracks, entries = [], []
    for root, dirs, files in os.walk(music_dir):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        for fn in sorted(files):
            if fn.startswith("."):
                continue
            ext = os.path.splitext(fn)[1].lower()
            if ext not in AUDIO_EXTS:
                continue
            entries.append((os.path.join(root, fn), fn))
    for full, fn in entries:
        rel = os.path.relpath(full, music_dir).replace(os.sep, "/")
        try:
            st = os.stat(full)
            mtime, size = int(st.st_mtime), st.st_size
        except OSError:
            continue
        if size < 100_000:  # skip corrupt/placeholders (e.g. zero-byte "mp3"s)
            continue
        track = {
            "id": rel,
            "path": rel,
            "dir": os.path.dirname(rel).replace(os.sep, "/") or ".",
            "file": fn,
            "size": size,
            "mtime": mtime,
        }
        track.update(read_tags(full, os.path.splitext(fn)[0]))
        tracks.append(track)
    return tracks


def load_cache():
    try:
        with open(CACHE_FILE) as fh:
            return json.load(fh)
    except Exception:
        return None


def save_cache(tracks):
    try:
        with open(CACHE_FILE, "w") as fh:
            json.dump({"tracks": tracks}, fh, ensure_ascii=False)
    except Exception:
        pass


def get_tracks(force=False):
    if CFG["cache"] is not None and not force:
        return CFG["cache"]
    cache = load_cache()
    if cache and not force:
        CFG["cache"] = cache["tracks"]
        return CFG["cache"]
    tracks = scan_tracks(CFG["music_dir"])
    CFG["cache"] = tracks
    save_cache(tracks)
    return tracks


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    def do_GET(self):
        path = unquote(self.path.split("?", 1)[0])
        if path == "/api/config":
            return self.send_json({"musicDir": CFG["music_dir"]})
        if path == "/api/tracks":
            return self.send_json(get_tracks(force="force" in self.path))
        if path.startswith("/audio/"):
            return self.send_audio(path[len("/audio/"):])
        if path.startswith("/api/"):
            return self.send_error(404, "no such api")
        return super().do_GET()

    def do_POST(self):
        path = unquote(self.path.split("?", 1)[0])
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        if path == "/api/log":
            try:
                with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "client.log"), "ab") as f:
                    f.write(("%s %s\n" % (self.log_date_time_string(), body.decode("utf-8", "replace").strip())).encode())
            except OSError:
                pass
            self.send_response(204)
            self.end_headers()
            return
        self.send_error(404)

    def send_json(self, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def send_audio(self, rel):
        music = os.path.realpath(CFG["music_dir"])
        full = os.path.realpath(os.path.join(music, rel))
        if not full.startswith(music + os.sep) and full != music:
            return self.send_error(403, "outside music dir")
        if not os.path.isfile(full):
            return self.send_error(404, "not found")
        size = os.path.getsize(full)
        ctype = MEDIA_TYPES.get(os.path.splitext(full)[1].lower(), "application/octet-stream")
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        status = 200
        if rng and rng.startswith("bytes="):
            try:
                a, _, b = rng[6:].split(",", 1)[0].partition("-")
                if a:
                    start = int(a)
                    end = int(b) if b else size - 1
                elif b:
                    start = max(0, size - int(b))
                end = min(end, size - 1)
                if start > end:
                    raise ValueError
                status = 206
            except ValueError:
                return self.send_error(416, "bad range")
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == 206:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.send_header("Cache-Control", "public, max-age=86400")
        self.end_headers()
        try:
            with open(full, "rb") as fh:
                fh.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = fh.read(min(256 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        return MEDIA_TYPES.get(ext) or super().guess_type(path)


def ensure_cert(extra_san=""):
    crt = os.path.join(APP_DIR, "cert.pem")
    key = os.path.join(APP_DIR, "cert.key")
    if os.path.exists(crt) and os.path.exists(key):
        return crt, key
    import socket
    import subprocess
    hn = socket.gethostname().split(".")[0]
    san = "DNS:localhost,DNS:%s,DNS:%s.local,DNS:%s,IP:127.0.0.1,IP:192.168.9.58" % (hn, hn, socket.getfqdn())
    if extra_san:
        san += "," + extra_san
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650",
         "-subj", "/CN=%s" % hn, "-addext", "subjectAltName=%s" % san,
         "-keyout", key, "-out", crt],
        check=True, capture_output=True)
    print("generated self-signed cert (%s)" % san)
    return crt, key


def main():
    ap = argparse.ArgumentParser(description="Trackatrack server")
    ap.add_argument("--music-dir", default=os.path.expanduser("~/Music"))
    ap.add_argument("--port", type=int, default=8360)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--rescan", action="store_true", help="force library rescan")
    ap.add_argument("--ssl", action="store_true", help="serve HTTPS with a self-signed cert")
    ap.add_argument("--san", default="DNS:kressh", help="extra cert SAN entries (LAN alias names)")
    args = ap.parse_args()
    CFG["music_dir"] = os.path.realpath(os.path.expanduser(args.music_dir))
    os.chdir(APP_DIR)
    if args.rescan:
        get_tracks(force=True)
        print("rescanned: %d tracks" % len(CFG["cache"]))
    tracks = get_tracks()
    scheme = "https" if args.ssl else "http"
    print("music dir: %s (%d tracks)" % (CFG["music_dir"], len(tracks)))
    print("%s://localhost:%d" % (scheme, args.port))
    try:
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        print("%s://%s:%d" % (scheme, s.getsockname()[0], args.port))
        s.close()
    except OSError:
        pass
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    if args.ssl:
        import ssl
        crt, key = ensure_cert(args.san)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(crt, key)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
