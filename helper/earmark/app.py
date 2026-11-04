"""The running helper: library, speech engine, live streams, clip cutting, the judge, Twitch's pictures, pairing, sync."""

from __future__ import annotations

import queue
import re
import secrets
import threading
import time
import uuid
from datetime import datetime

from . import __version__
from .asr import Engine
from .config import Settings, extension_token
from .judge import Judge
from .library import Library
from .media import LOW, cut, low_copy, video_height
from .patterns import Pattern, builtin, custom
from .session import Session
from .twitch import Twitch


def slug_of(value) -> str | None:
    """a Twitch category's address name, as in /directory/category/just-chatting"""
    text = str(value or "").strip().lower()
    return text if re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", text) else None


class Clipper:
    """Cuts moments one at a time, so a burst of them never starts a pile of ffmpegs."""

    def __init__(self, app: "App"):
        self.app = app
        self._q: queue.Queue = queue.Queue()
        threading.Thread(target=self._run, name="clipper", daemon=True).start()

    def add(self, session: Session, job: str, mid: str, t0: float, t1: float) -> None:
        self._q.put((session, job, mid, t0, t1))

    def _run(self) -> None:
        while True:
            session, job, mid, t0, t1 = self._q.get()
            try:
                deadline = time.time() + 40
                segments = session.recorder.segments()
                while time.time() < deadline and session.recorder.alive:
                    if segments and segments[-1][2] >= t1:
                        break
                    time.sleep(0.5)
                    segments = session.recorder.segments()
                segments = session.recorder.segments()
                day = datetime.fromtimestamp(session.started + t0)
                clip, poster, thumb, low = (f"{kind}/{day:%Y/%m}/{mid}.{ext}" for kind, ext in
                                            (("clips", "mp4"), ("posters", "jpg"), ("thumbs", "jpg"), ("clips", "low.mp4")))
                media = self.app.settings.media
                if cut(segments, t0, t1, media / clip, media / poster, t0 + min(4.0, (t1 - t0) / 3), media / thumb):
                    # (a stream watched at 360p or less has nothing lighter to offer)
                    height = video_height(media / clip)
                    light = bool(height and height > LOW + 40) and low_copy(media / clip, media / low)
                    self.app.library.attach_media(mid, clip, poster if (media / poster).exists() else None,
                                                  thumb if (media / thumb).exists() else None, low if light else None, height)
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
        self.twitch = Twitch()
        self.sessions: dict[str, Session] = {}
        self._lock = threading.Lock()
        self._patterns: list[Pattern] | None = None
        self.pairing: dict[str, dict] = {}
        self.clipper = Clipper(self)
        self.sync = None
        if settings.sync_url and settings.sync_token:
            from .sync import Sync

            self.sync = Sync(self)
        self.judge = Judge(self)
        threading.Thread(target=self._reaper, name="reaper", daemon=True).start()
        threading.Thread(target=self._housekeeping, name="housekeeping", daemon=True).start()

    # phrases (the rules the judge falls back on) ------------------------------------------------------------------
    def patterns(self) -> list[Pattern]:
        if self._patterns is None:
            self._patterns = builtin() + custom(self.library.custom_patterns())
        return self._patterns

    def patterns_changed(self) -> None:
        self._patterns = None

    # streams -----------------------------------------------------------------------------------------------------
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
            "categorySlug": slug_of(meta.get("categorySlug")),
        }
        self.library.add_session({"id": sid, "startedAt": time.time(), **clean})
        session = Session(self, sid, clean)
        with self._lock:
            self.sessions[sid] = session
        threading.Thread(target=self.resolve, args=(session, clean), name="resolve", daemon=True).start()
        return session

    def resolve(self, session: Session | None, meta: dict, sid: str | None = None) -> None:
        """What the page said, made right with Twitch: the category's English name (the page shows it in your
        language), and for a VOD its title and category (its page doesn't show them the way a live one does)."""
        sid = session.id if session else sid
        fields: dict = {}
        if meta.get("categorySlug"):
            cat = self.twitch.category(meta["categorySlug"])
            if cat:
                fields["category"] = cat["name"]
                if cat.get("boxArt"):
                    self.library.set_box_art(cat["name"], cat["boxArt"])
        if meta.get("kind") == "vod" and meta.get("vodId"):
            v = self.twitch.video(meta["vodId"])
            if v:
                fields.setdefault("category", v["category"])
                fields["title"] = v["title"]
                if v.get("displayName"):
                    fields["displayName"] = v["displayName"]
        fields = {k: v for k, v in fields.items() if v}
        if fields and sid:
            self.library.update_session(sid, **fields)
            if session:
                session.meta.update(fields)
        self.fetch_art()

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

    # Twitch's pictures, and tidying up ----------------------------------------------------------------------------
    def fetch_art(self) -> None:
        cats, chans = self.library.needs_art()
        for c in cats:
            url = self.twitch.box_art(c)
            if url:
                self.library.set_box_art(c, url)
        if chans:
            for login, info in self.twitch.channels(chans).items():
                self.library.set_channel_avatar(login, info.get("avatar"), info.get("displayName"))

    def _housekeeping(self) -> None:
        time.sleep(20)
        while True:
            try:
                for row in self.library.vods_to_resolve():
                    self.resolve(None, {"kind": "vod", "vodId": row["vod_id"]}, sid=row["id"])
                self.fetch_art()
                self.library.forget_old_media(time.time() - self.settings.keep_days * 86400)
            except Exception:
                pass
            time.sleep(6 * 3600)

    # pairing the extension -----------------------------------------------------------------------------------------
    def pair_request(self, origin: str) -> dict:
        now = time.time()
        self.pairing = {k: v for k, v in self.pairing.items() if now - v["created"] < 600}
        if sum(1 for v in self.pairing.values() if v["state"] == "pending") >= 5:
            raise ValueError("too many pending requests")
        rid = secrets.token_urlsafe(9)
        # by default the extension connects by itself; with EARMARK_AUTO_PAIR=0 you allow it on the dashboard
        state = "allowed" if self.settings.auto_pair and origin.startswith("chrome-extension://") else "pending"
        self.pairing[rid] = {"origin": origin, "created": now, "state": state}
        return {"id": rid, "state": state}

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

    # status ----------------------------------------------------------------------------------------------------------
    def engine_status(self) -> dict:
        return {"name": self.engine.name, "ready": self.engine.ready, "error": self.engine.error}

    def status(self) -> dict:
        with self._lock:
            live = [s.status() for s in self.sessions.values()]
        site = self.settings.sync_url or f"http://127.0.0.1:{self.settings.port}"
        return {"version": self.version, "engine": self.engine_status(), "judge": self.judge.status(),
                "sessions": live, "site": site}
