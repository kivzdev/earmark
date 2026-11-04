"""One watched stream: audio comes in, sentences come out, and every minute or so of them becomes a moment —
its video, its transcript word by word — for the judge to keep or let go."""

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
PAD_BEFORE, PAD_AFTER = 0.4, 0.6
MOMENT = 55.0  # a moment closes at the first sentence end after this long
MOMENT_MIN = 12.0  # less speech than this isn't a moment
QUIET = 15.0  # a silence this long (music, a menu) ends a moment early

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
        self.moments = 0
        self.error: str | None = None
        self._ending = threading.Event()
        self._ffmpeg_done = threading.Event()
        self._pending: dict[str, float] = {}  # clip job id → start time it still needs
        self._pending_lock = threading.Lock()
        self._sentences: list[list[tuple[str, float, float]]] = []  # the moment being gathered
        self._last_moment_end = 0.0
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
                    after = sentences[i + 1][0][1] if i + 1 < len(sentences) else None
                    self._on_sentence(s, after)
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
            keep = min([pos - 10, (self._sentences[0][0][1] if self._sentences else pos) - 2, *self._pending.values()])
        self.recorder.forget_before(keep - 2)

    # sentences → moments ----------------------------------------------------------------------------------------
    def _on_sentence(self, words: list[tuple[str, float, float]], after: float | None) -> None:
        text, _ = _sentence_text(words)
        self.words += len(words)
        with self._transcript.open("a", encoding="utf-8") as f:
            f.write(json.dumps({"t0": round(words[0][1], 2), "t1": round(words[-1][2], 2), "text": text}) + "\n")
        if self._sentences and words[0][1] - self._sentences[-1][-1][2] > QUIET:
            self._close_moment(words[0][1])
        self._sentences.append(words)
        if words[-1][2] - self._sentences[0][0][1] >= MOMENT:
            self._close_moment(after)

    def _close_moment(self, next_start: float | None) -> None:
        sentences, self._sentences = self._sentences, []
        if not sentences:
            return
        s0, s1 = sentences[0][0][1], sentences[-1][-1][2]
        if s1 - s0 < MOMENT_MIN:
            return
        # padding that stops short of the neighbours' words
        t0 = max(0.0, s0 - min(PAD_BEFORE, max(0.05, s0 - self._last_moment_end - 0.05)))
        t1 = s1 + (PAD_AFTER if next_start is None else min(PAD_AFTER, max(0.08, next_start - s1 - 0.05)))
        self._last_moment_end = t1
        mid = uuid.uuid4().hex[:12]
        self.app.library.add_moment({
            "id": mid, "sessionId": self.id, "t0": round(t0, 2), "t1": round(t1, 2), "at": self.started + t0,
            "sentences": [{
                "t0": round(ws[0][1] - t0, 2), "t1": round(ws[-1][2] - t0, 2), "text": _sentence_text(ws)[0],
                "words": [[w, round(a - t0, 2), round(b - t0, 2)] for w, a, b in ws],
            } for ws in sentences],
        })
        self.moments += 1
        job = uuid.uuid4().hex[:8]
        with self._pending_lock:
            self._pending[job] = t0
        self.app.clipper.add(self, job, mid, t0, t1)
        self.app.judge.add(mid)

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
        self._close_moment(None)
        self.recorder.close()
        self.recorder.wait()
        deadline = time.time() + 180
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
            "moments": self.moments,
            "recent": self.app.library.recent_moments(self.id, 4),
            "error": self.error,
            "ending": self.ending,
        }
