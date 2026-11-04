"""One watched stream: audio comes in, sentences come out, phrases get caught and clipped."""

from __future__ import annotations

import json
import re
import shutil
import threading
import time
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

import numpy as np

from . import patterns as P
from .categories import classify
from .media import Recorder

if TYPE_CHECKING:
    from .app import App

RATE = 16_000
WINDOW = 20.0  # transcribe once this much new audio has arrived
MAX_WINDOW = 45.0
TAIL = 2.5  # words this close to the end of a window may still change
CONTEXT = 0.3
GAP = 1.2  # a pause this long ends a sentence
LONGEST = 20.0  # longer sentences split at the next short pause
PAD_BEFORE, PAD_AFTER = 0.35, 0.6
CLIP_MAX = 12.0
CLIP_EVERY = 3.0  # at most one new clip per this many seconds of stream
CLIP_CAP = {3: 4, 2: 3, 1: 2}  # clips kept per phrase per streamer, by how interesting the phrase is
TEXT_CAP = 25  # sentences kept per phrase per streamer, clipped or not

END = re.compile(r"[.?!][\"')\]]*$")


class PcmRing:
    """16-bit mono PCM addressed by stream time; old audio is dropped as it's transcribed."""

    def __init__(self) -> None:
        self._buf = bytearray()
        self._base = 0  # sample index of _buf[0]
        self._lock = threading.Lock()
        self.total = 0  # samples received

    def append(self, data: bytes) -> None:
        with self._lock:
            self._buf += data
            self.total = self._base + len(self._buf) // 2

    @property
    def end(self) -> float:
        return self.total / RATE

    def slice(self, t0: float, t1: float) -> np.ndarray:
        with self._lock:
            a = max(0, int(t0 * RATE) - self._base)
            b = max(a, int(t1 * RATE) - self._base)
            raw = bytes(self._buf[a * 2 : b * 2])
        return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0

    def forget_before(self, t: float) -> None:
        with self._lock:
            n = int(t * RATE) - self._base
            if n > 0:
                del self._buf[: n * 2]
                self._base += n


def split_sentences(words: list[tuple[str, float, float]]) -> list[list[tuple[str, float, float]]]:
    out, cur = [], []
    for w in words:
        if cur:
            pause = w[1] - cur[-1][2]
            if pause > GAP or (w[1] - cur[0][1] > LONGEST and pause > 0.35):
                out.append(cur)
                cur = []
        cur.append(w)
        if END.search(w[0]) and len(w[0]) > 1:
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return out


def _sentence_text(words) -> tuple[str, list[tuple[int, int]]]:
    """Joined text and the character span of every word in it."""
    text, spans = "", []
    for w, _, _ in words:
        if text:
            text += " "
        spans.append((len(text), len(text) + len(w)))
        text += w
    return text, spans


class Session:
    def __init__(self, app: "App", sid: str, meta: dict):
        self.app = app
        self.id = sid
        self.meta = meta
        self.channel = meta["channel"]
        self.started = time.time()
        self.last_seen = time.time()
        self.seq = 0
        self.words = 0
        self.error: str | None = None
        self.recent: list[dict] = []  # newest catches, for the extension popup
        self.caught = 0
        self._ending = threading.Event()
        self._ffmpeg_done = threading.Event()
        self._pending: dict[str, float] = {}  # clip job id → start time it still needs
        self._pending_lock = threading.Lock()
        self._last_clip = -1e9
        self._last_end = 0.0
        self.pcm = PcmRing()
        self.dir = app.settings.home / "buffer" / sid
        day = datetime.now().strftime("%Y-%m-%d")
        self._transcript = app.settings.home / "transcripts" / day / f"{sid}.jsonl"
        self._transcript.parent.mkdir(parents=True, exist_ok=True)
        self.recorder = Recorder(self.dir, self.pcm.append, self._on_ffmpeg_exit)
        self._thread = threading.Thread(target=self._loop, name=f"asr-{sid}", daemon=True)
        self._thread.start()

    # input ------------------------------------------------------------------
    def feed(self, seq: int, data: bytes) -> None:
        self.last_seen = time.time()
        if seq <= self.seq:  # a retried chunk we already have
            return
        self.seq = seq
        self.recorder.feed(data)

    def end(self) -> None:
        if not self._ending.is_set():
            self._ending.set()
            self.recorder.close()

    @property
    def ending(self) -> bool:
        return self._ending.is_set()

    def _on_ffmpeg_exit(self, err: str) -> None:
        if err and not self.ending:
            self.error = err.splitlines()[-1] if err else None
        self._ffmpeg_done.set()
        self._ending.set()

    # speech → sentences ----------------------------------------------------------
    def _loop(self) -> None:
        pos = 0.0
        try:
            while True:
                final = self._ffmpeg_done.is_set()
                end = self.pcm.end
                if not final and end - pos < WINDOW:
                    self._ffmpeg_done.wait(0.5)
                    continue
                if end - pos < 0.5:
                    break
                w0 = max(0.0, pos - CONTEXT)
                w1 = min(end, w0 + MAX_WINDOW)
                last = final and w1 >= end
                audio = self.pcm.slice(w0, w1)
                words = [(t, s + w0, e + w0) for t, s, e in self.app.engine.transcribe(audio)]
                words = [w for w in words if (w[1] + w[2]) / 2 >= pos]
                cutoff = w1 if last else w1 - TAIL
                sentences = split_sentences(words)
                commit = []
                for s in sentences:
                    if s[-1][2] <= cutoff:
                        commit.append(s)
                    else:
                        break
                if not commit and w1 - pos >= MAX_WINDOW - 1:
                    early = [w for w in words if w[2] <= cutoff]
                    if early:
                        commit = [early]
                for i, s in enumerate(commit):
                    # neighbours bound the clip's padding, so it doesn't pick up their words
                    before = commit[i - 1][-1][2] if i else self._last_end
                    after = sentences[i + 1][0][1] if i + 1 < len(sentences) else None
                    self._on_sentence(s, before, after)
                    self._last_end = s[-1][2]
                if commit:
                    pos = commit[-1][-1][2]
                    self.app.library.update_session(self.id, heard=self.pcm.end, words=self.words)
                elif last:
                    break
                elif not words and w1 - pos > WINDOW:
                    pos = w1 - TAIL  # nothing said: move on
                self.pcm.forget_before(pos - 5)
                self._forget_segments(pos)
        except Exception as error:  # keep the stream's data; report in the popup
            self.error = f"{type(error).__name__}: {error}"
        finally:
            self._finish()

    def _forget_segments(self, pos: float) -> None:
        with self._pending_lock:
            keep = min([pos - 10, *self._pending.values()])
        self.recorder.forget_before(keep - 2)

    def _on_sentence(self, words: list[tuple[str, float, float]], before: float, after: float | None) -> None:
        text, spans = _sentence_text(words)
        self.words += len(words)
        with self._transcript.open("a", encoding="utf-8") as f:
            f.write(json.dumps({"t0": round(words[0][1], 2), "t1": round(words[-1][2], 2), "text": text}) + "\n")
        hits = P.find(self.app.patterns(), text)
        if not hits:
            return
        lib = self.app.library
        keep = []
        for pattern, a, b in hits:
            if lib.count(pattern.id, self.channel, with_clip=False) >= TEXT_CAP:
                continue
            if lib.seen_sentence(pattern.id, self.channel, text):
                continue
            keep.append((pattern, a, b))
        if not keep:
            return
        keep.sort(key=lambda h: -h[0].weight)
        s_start, s_end = words[0][1], words[-1][2]
        # the clip is the sentence, trimmed around the best phrase if it runs long
        best, a, b = keep[0]
        idx = [i for i, (x, y) in enumerate(spans) if y > a and x < b] or [0]
        m0, m1 = words[idx[0]][1], words[idx[-1]][2]
        t0, t1 = s_start, s_end
        if t1 - t0 > CLIP_MAX:
            t0 = max(s_start, min(m0 - 4.0, s_end - CLIP_MAX))
            t1 = min(s_end, t0 + CLIP_MAX)
        if t0 == s_start:
            t0 -= min(PAD_BEFORE, max(0.05, s_start - before - 0.05))
        if t1 == s_end:
            t1 += PAD_AFTER if after is None else min(PAD_AFTER, max(0.08, after - s_end - 0.05))
        t0 = max(0.0, t0)
        want_clip = t0 - self._last_clip >= CLIP_EVERY and any(
            lib.count(p.id, self.channel, with_clip=True) < CLIP_CAP.get(p.weight, 2) for p, _, _ in keep
        )
        at = self.started + t0  # close enough: stream time maps to wall time
        rel_words = [[w, round(s - t0, 2), round(e - t0, 2)] for w, s, e in words if s >= t0 - 0.05 and e <= t1 + 0.05]
        ids = []
        for pattern, a, b in keep:
            cid = uuid.uuid4().hex[:12]
            ids.append(cid)
            lib.add_catch({
                "id": cid, "sessionId": self.id, "pattern": pattern.id, "sentence": text, "match": [a, b],
                "words": rel_words, "t0": round(t0, 2), "t1": round(t1, 2), "at": at,
            })
            self.caught += 1
            self.recent.insert(0, {"id": cid, "pattern": pattern.label, "sentence": text, "at": at})
        del self.recent[12:]
        if want_clip:
            self._last_clip = t0
            job = uuid.uuid4().hex[:8]
            with self._pending_lock:
                self._pending[job] = t0
            self.app.clipper.add(self, job, ids, t0, t1, m0)

    def clip_done(self, job: str) -> None:
        with self._pending_lock:
            self._pending.pop(job, None)

    @property
    def clips_pending(self) -> int:
        with self._pending_lock:
            return len(self._pending)

    # done -------------------------------------------------------------------
    def _finish(self) -> None:
        self._ending.set()
        self.recorder.close()
        self.recorder.wait()
        deadline = time.time() + 120
        while self.clips_pending and time.time() < deadline:
            time.sleep(0.5)
        self.app.library.update_session(self.id, endedAt=time.time(), heard=self.pcm.end, words=self.words)
        shutil.rmtree(self.dir, ignore_errors=True)
        self.app.session_finished(self)

    def status(self) -> dict:
        group, game = classify(self.meta.get("category"), self.meta.get("title"), self.meta.get("tags"))
        return {
            "id": self.id,
            "channel": self.channel,
            "group": group,
            "game": game,
            "heard": round(self.pcm.end, 1),
            "words": self.words,
            "caught": self.caught,
            "recent": self.recent[:5],
            "error": self.error,
            "ending": self.ending,
        }
