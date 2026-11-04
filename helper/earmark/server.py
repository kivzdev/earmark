"""The local HTTP server: the extension's ingest API, the dashboard's API, the dashboard itself.

It only listens on 127.0.0.1. Requests must name this machine in their Host header
(so a web page can't reach it through DNS rebinding); the extension's calls carry a
secret token; the dashboard's changes need a custom header no other site can send.
"""

from __future__ import annotations

import hmac
import json
import mimetypes
import re
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .app import App
from .categories import GROUPS
from .config import REPO
from .patterns import KINDS, phrase_to_regex
from .autostart import is_on as autostart_on

WEB = REPO / "dist"
MAX_CHUNK = 8 * 1024 * 1024

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://static-cdn.jtvnw.net; "
    "media-src 'self' blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; "
    "form-action 'self'"
)


class Handler(BaseHTTPRequestHandler):
    server_version = "Earmark"
    sys_version = ""
    app: App

    def log_message(self, fmt, *args) -> None:  # keep the terminal quiet
        pass

    # helpers -----------------------------------------------------------------
    def _send(self, code: int, body: bytes = b"", ctype: str = "application/json", headers: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self._cors()
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code: int, obj) -> None:
        self._send(code, json.dumps(obj, separators=(",", ":")).encode())

    def _error(self, code: int, message: str) -> None:
        self._json(code, {"error": message})

    def _cors(self) -> None:
        origin = self.headers.get("Origin", "")
        if origin.startswith("chrome-extension://") and self.path.startswith("/v1/"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def _body(self, limit: int = 256 * 1024) -> bytes | None:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if length < 0 or length > limit:
            return None
        return self.rfile.read(length) if length else b""

    def _json_body(self) -> dict | None:
        raw = self._body()
        if raw is None:
            return None
        try:
            data = json.loads(raw or b"{}")
        except ValueError:
            return None
        return data if isinstance(data, dict) else None

    def _host_ok(self) -> bool:
        port = self.app.settings.port
        return self.headers.get("Host", "") in (f"127.0.0.1:{port}", f"localhost:{port}")

    def _extension_ok(self) -> bool:
        given = self.headers.get("X-Earmark-Token", "")
        return bool(given) and hmac.compare_digest(given.encode(), self.app.token.encode())

    def _dashboard_ok(self) -> bool:
        """State changes from the dashboard: a custom header (forces a preflight we never
        approve for other sites) and, when the browser sends one, our own Origin."""
        if self.headers.get("X-Earmark") != "1":
            return False
        origin = self.headers.get("Origin")
        port = self.app.settings.port
        return origin in (None, f"http://127.0.0.1:{port}", f"http://localhost:{port}")

    # verbs -------------------------------------------------------------------
    def do_OPTIONS(self) -> None:
        origin = self.headers.get("Origin", "")
        if not self._host_ok() or not origin.startswith("chrome-extension://") or not self.path.startswith("/v1/"):
            self._send(403, b"")
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Earmark-Token")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        self._route("GET")

    def do_HEAD(self) -> None:
        self._route("GET")

    def do_POST(self) -> None:
        self._route("POST")

    def do_PATCH(self) -> None:
        self._route("PATCH")

    def do_DELETE(self) -> None:
        self._route("DELETE")

    def _route(self, method: str) -> None:
        if not self._host_ok():
            self._send(421, b"wrong host", "text/plain")
            return
        url = urlparse(self.path)
        path = url.path
        try:
            if path.startswith("/v1/"):
                return self._extension(method, path, parse_qs(url.query))
            if path.startswith("/api/"):
                return self._api(method, path, parse_qs(url.query))
            if path.startswith("/media/") and method == "GET":
                return self._media(path[len("/media/"):])
            if method == "GET":
                return self._static(path)
            self._error(405, "method not allowed")
        except BrokenPipeError:
            pass

    # the extension -------------------------------------------------------------
    def _extension(self, method: str, path: str, query: dict) -> None:
        app = self.app
        m = re.fullmatch(r"/v1/pair(?:/([\w-]{6,20}))?", path)
        if m:
            # a web page can't ask (Chrome leaves the Origin off some extension requests, so none is fine too); what
            # actually guards pairing is that you allow it on the dashboard
            origin = self.headers.get("Origin", "")
            if origin and not origin.startswith("chrome-extension://"):
                return self._error(403, "pairing is for the Earmark extension")
            if method == "POST" and not m[1]:
                try:
                    return self._json(200, app.pair_request(origin))
                except ValueError as e:
                    return self._error(429, str(e))
            if method == "GET" and m[1]:
                return self._json(200, app.pair_poll(m[1]))
            return self._error(405, "method not allowed")
        if not self._extension_ok():
            return self._error(401, "not paired")
        if path == "/v1/status" and method == "GET":
            return self._json(200, app.status())
        if path == "/v1/sessions" and method == "POST":
            meta = self._json_body()
            if meta is None:
                return self._error(400, "bad body")
            if not app.engine.ready and app.engine.error:
                return self._error(503, app.engine.error)
            try:
                session = app.start_session(meta)
            except ValueError as e:
                return self._error(400, str(e))
            return self._json(200, {"id": session.id})
        m = re.fullmatch(r"/v1/sessions/([a-f0-9]{12})/(chunk|meta|end|status)", path)
        if not m:
            return self._error(404, "not found")
        session = app.session(m[1])
        if session is None or (session.ending and m[2] == "chunk"):
            return self._error(410, "session is over")
        if m[2] == "chunk" and method == "POST":
            data = self._body(MAX_CHUNK)
            if data is None:
                return self._error(413, "chunk too large")
            try:
                seq = int((query.get("seq") or ["0"])[0])
            except ValueError:
                return self._error(400, "bad seq")
            try:
                session.feed(seq, data)
            except (BrokenPipeError, OSError):
                session.end()
                return self._error(410, "decoder stopped")
            return self._json(200, {"moments": session.moments, "error": session.error})
        if m[2] == "meta" and method == "POST":
            meta = self._json_body() or {}
            fields = {k: meta[k] for k in ("category", "title", "displayName") if isinstance(meta.get(k), str)}
            if isinstance(meta.get("tags"), list):
                fields["tags"] = [str(t)[:40] for t in meta["tags"]][:20]
            app.library.update_session(session.id, **fields)
            session.meta.update(fields)
            return self._json(200, {"ok": True})
        if m[2] == "end" and method == "POST":
            session.end()
            return self._json(200, {"ok": True})
        if m[2] == "status" and method == "GET":
            return self._json(200, session.status())
        return self._error(405, "method not allowed")

    # the dashboard -------------------------------------------------------------
    def _api(self, method: str, path: str, query: dict) -> None:
        app = self.app
        if method == "GET":
            if path == "/api/meta":
                return self._json(200, {
                    "mode": "local",
                    "version": app.version,
                    "engine": app.engine_status(),
                    "judge": app.judge.status(),
                    "sync": app.sync.status() if app.sync else None,
                    "pairing": app.pending_pairs(),
                    "live": app.status()["sessions"],
                    "kinds": KINDS,
                    "home": str(app.settings.home),
                    "autostart": autostart_on(),
                    "phrases": [{"id": r["id"], "label": r["label"]} for r in app.library.custom_patterns()],
                })
            if path == "/api/library":
                body = json.dumps(app.library.export(), separators=(",", ":")).encode()
                return self._send(200, body)
            if path == "/api/twitch/live":
                category = (query.get("category") or [""])[0][:120]
                return self._json(200, {"streams": app.twitch.live(category) if category else []})
            if path == "/api/twitch/channels":
                logins = [l for l in (query.get("logins") or [""])[0].split(",") if re.fullmatch(r"[a-z0-9_]{1,40}", l)]
                return self._json(200, {"channels": app.twitch.channels(logins[:50])})
            return self._error(404, "not found")
        if not self._dashboard_ok():
            return self._error(403, "forbidden")
        m = re.fullmatch(r"/api/moments/([a-f0-9]{12})", path)
        if m and method == "PATCH":
            data = self._json_body() or {}
            ok = "starred" in data and app.library.star(m[1], bool(data["starred"]))
            if ok and app.sync:
                app.sync.poke(snapshot=True)
            return self._json(200 if ok else 404, {"ok": ok})
        if m and method == "DELETE":
            ok = app.library.delete_moment(m[1])
            return self._json(200 if ok else 404, {"ok": ok})
        m = re.fullmatch(r"/api/channels/([a-z0-9_]{1,40})", path)
        if m and method == "PATCH":
            group = (self._json_body() or {}).get("group")
            if group is not None and group not in GROUPS:
                return self._error(400, "group must be politics, entertainment or gaming")
            app.library.set_channel_group(m[1], group)
            return self._json(200, {"ok": True})
        m = re.fullmatch(r"/api/pairing/([\w-]{6,20})", path)
        if m and method == "POST":
            allow = bool((self._json_body() or {}).get("allow"))
            return self._json(200, {"ok": app.pair_answer(m[1], allow)})
        if path == "/api/patterns" and method == "POST":
            data = self._json_body() or {}
            phrase = str(data.get("phrase") or "").strip()[:120]
            if not phrase:
                return self._error(400, "phrase is required")
            try:
                regex = phrase_to_regex(phrase)
                if re.compile(regex, re.I).search(""):
                    raise ValueError("it matches everything")
            except (re.error, ValueError) as e:
                return self._error(400, f"can't use that phrase: {e}")
            kind = data.get("kind") if data.get("kind") in KINDS else "frame"
            label = str(data.get("label") or phrase.removeprefix("re:")).strip()[:80]
            pid = "my-" + uuid.uuid4().hex[:8]
            app.library.add_pattern({"id": pid, "label": label, "regex": regex, "kind": kind,
                                     "note": str(data.get("note") or "")[:200]})
            app.patterns_changed()
            return self._json(200, {"id": pid})
        m = re.fullmatch(r"/api/patterns/(my-[a-f0-9]{8})", path)
        if m and method == "DELETE":
            ok = app.library.delete_pattern(m[1])
            app.patterns_changed()
            return self._json(200 if ok else 404, {"ok": ok})
        return self._error(404, "not found")

    def _media(self, rel: str) -> None:
        if not re.fullmatch(r"(clips/\d{4}/\d{2}/[a-f0-9]{12}\.mp4|(posters|thumbs)/\d{4}/\d{2}/[a-f0-9]{12}\.jpg)", rel):
            return self._error(404, "not found")
        path = self.app.settings.media / rel
        if not path.is_file():
            return self._error(404, "not found")
        self._file(path, "video/mp4" if rel.endswith(".mp4") else "image/jpeg", cache="private, max-age=31536000, immutable")

    def _static(self, path: str) -> None:
        if not WEB.is_dir():
            msg = b"Earmark is running. Build the dashboard first: npm install && npm run build"
            return self._send(200, msg, "text/plain; charset=utf-8")
        target = (WEB / path.lstrip("/")).resolve()
        if not target.is_relative_to(WEB.resolve()) or not target.is_file():
            target = WEB / "index.html"  # client-side routes
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml"):
            ctype += "; charset=utf-8"
        cache = "public, max-age=31536000, immutable" if "/assets/" in target.as_posix() else "no-cache"
        self._file(target, ctype, cache=cache, csp=target.suffix == ".html")

    def _file(self, path: Path, ctype: str, cache: str, csp: bool = False) -> None:
        size = path.stat().st_size
        start, end = 0, size - 1
        code = 200
        rng = self.headers.get("Range")
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng or "")
        if m and (m[1] or m[2]):
            if m[1]:
                start = int(m[1])
                end = min(int(m[2]), size - 1) if m[2] else size - 1
            else:
                start = max(0, size - int(m[2]))
            if start > end or start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            code = 206
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if csp:
            self.send_header("Content-Security-Policy", CSP)
            self.send_header("X-Frame-Options", "DENY")
        if code == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self.command == "HEAD":
            return
        with path.open("rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = f.read(min(65536, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)


def serve(app: App) -> None:
    Handler.app = app
    httpd = ThreadingHTTPServer(("127.0.0.1", app.settings.port), Handler)
    httpd.daemon_threads = True
    httpd.serve_forever()
