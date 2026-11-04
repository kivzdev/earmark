"""The running helper: library, speech engine, live streams, clip cutting, pairing, sync."""

from __future__ import annotations

import queue
import secrets
import threading
import time
import uuid
from datetime import datetime

from . import __version__
from .asr import Engine
from .config import Settings, extension_token
from .library import Library
from .media import cut
from .patterns import Pattern, builtin, custom
from .session import Session


class Clipper:
    """Cuts clips one at a time, so a burst of phrases never starts a pile of ffmpegs."""

    def __init__(self, app: "App"):
        self.app = app
        self._q: queue.Queue = queue.Queue()
        threading.Thread(target=self._run, name="clipper", daemon=True).start()

    def add(self, session: Session, job: str, ids: list[str], t0: float, t1: float, poster_at: float) -> None:
        self._q.put((session, job, ids, t0, t1, poster_at))

    def _run(self) -> None:
        while True:
            session, job, ids, t0, t1, poster_at = self._q.get()
            try:
                deadline = time.time() + 30
                segments = session.recorder.segments()
                while time.time() < deadline and session.recorder.alive:
                    if segments and segments[-1][2] >= t1:
                        break
                    time.sleep(0.5)
                    segments = session.recorder.segments()
                segments = session.recorder.segments()
                day = datetime.fromtimestamp(session.started + t0)
                clip = f"clips/{day:%Y/%m}/{ids[0]}.mp4"
                poster = f"posters/{day:%Y/%m}/{ids[0]}.jpg"
                media = self.app.settings.media
                if cut(segments, t0, t1, media / clip, media / poster, poster_at):
                    self.app.library.attach_clip(ids, clip, poster if (media / poster).exists() else None)
                    if self.app.sync:
                        self.app.sync.poke()
            except Exception as error:
                session.error = f"clip: {error}"
            finally:
                session.clip_done(job)


class App:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.version = __version__
        self.library = Library(settings.db_path, settings.media)
        self.engine = Engine(settings)
        self.token = extension_token(settings.home)
        self.sessions: dict[str, Session] = {}
        self._lock = threading.Lock()
        self._patterns: list[Pattern] | None = None
        self.pairing: dict[str, dict] = {}
        self.clipper = Clipper(self)
        self.sync = None
        if settings.sync_url and settings.sync_token:
            from .sync import Sync

            self.sync = Sync(self)
        threading.Thread(target=self._reaper, name="reaper", daemon=True).start()

    # phrases -----------------------------------------------------------------
    def patterns(self) -> list[Pattern]:
        if self._patterns is None:
            self._patterns = builtin() + custom(self.library.custom_patterns())
        return self._patterns

    def patterns_changed(self) -> None:
        self._patterns = None

    # streams -----------------------------------------------------------------
    def start_session(self, meta: dict) -> Session:
        sid = uuid.uuid4().hex[:12]
        channel = str(meta.get("channel") or "").lower()[:40]
        if not channel:
            raise ValueError("channel is required")
        clean = {
            "channel": channel,
            "displayName": str(meta.get("displayName") or channel)[:60],
            "category": str(meta.get("category") or "")[:120] or None,
            "title": str(meta.get("title") or "")[:300] or None,
            "tags": [str(t)[:40] for t in (meta.get("tags") or [])][:20],
            "kind": "vod" if meta.get("kind") == "vod" else "live",
            "vodId": str(meta.get("vodId") or "")[:20] or None,
            "vodOffset": float(meta["vodOffset"]) if isinstance(meta.get("vodOffset"), (int, float)) else None,
        }
        self.library.add_session({"id": sid, "startedAt": time.time(), **clean})
        session = Session(self, sid, clean)
        with self._lock:
            self.sessions[sid] = session
        return session

    def session(self, sid: str) -> Session | None:
        with self._lock:
            return self.sessions.get(sid)

    def session_finished(self, session: Session) -> None:
        with self._lock:
            self.sessions.pop(session.id, None)
        if self.sync:
            self.sync.poke(snapshot=True)

    def _reaper(self) -> None:
        """A tab that stops sending (closed, crashed, asleep) ends its stream."""
        while True:
            time.sleep(5)
            with self._lock:
                live = list(self.sessions.values())
            for s in live:
                if not s.ending and time.time() - s.last_seen > 45:
                    s.end()

    # pairing the extension ---------------------------------------------------
    def pair_request(self, origin: str) -> str:
        now = time.time()
        self.pairing = {k: v for k, v in self.pairing.items() if now - v["created"] < 600}
        if sum(1 for v in self.pairing.values() if v["state"] == "pending") >= 5:
            raise ValueError("too many pending requests")
        rid = secrets.token_urlsafe(9)
        self.pairing[rid] = {"origin": origin, "created": now, "state": "pending"}
        return rid

    def pair_answer(self, rid: str, allow: bool) -> bool:
        req = self.pairing.get(rid)
        if not req or req["state"] != "pending":
            return False
        req["state"] = "allowed" if allow else "denied"
        return True

    def pair_poll(self, rid: str) -> dict:
        req = self.pairing.get(rid)
        if not req:
            return {"state": "gone"}
        if req["state"] == "allowed":
            del self.pairing[rid]  # the token is handed out once
            return {"state": "allowed", "token": self.token}
        return {"state": req["state"]}

    def pending_pairs(self) -> list[dict]:
        now = time.time()
        return [
            {"id": k, "origin": v["origin"], "created": v["created"]}
            for k, v in self.pairing.items()
            if v["state"] == "pending" and now - v["created"] < 600
        ]

    # status --------------------------------------------------------------------
    def engine_status(self) -> dict:
        return {"name": self.engine.name, "ready": self.engine.ready, "error": self.engine.error}

    def status(self) -> dict:
        with self._lock:
            live = [s.status() for s in self.sessions.values()]
        return {"version": self.version, "engine": self.engine_status(), "sessions": live}
