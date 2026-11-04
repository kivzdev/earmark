"""Which moments are worth keeping, and what in them is worth learning.

With an Anthropic API key (ANTHROPIC_API_KEY in .env), Claude Haiku 5.5 reads each minute's transcript and answers
with a score, a short title and the everyday expressions in it — about a cent or two per hour of stream. Without a
key, the built-in phrase list does the same job by rules.
"""

from __future__ import annotations

import json
import queue
import threading
import time

from . import patterns as P

PICK_AI = 6  # a moment Claude scores this high (0-10) is kept for you
PICK_RULES = 3  # (real talk has fewer listed phrases than you'd think)

SYSTEM = """You help an intermediate English learner pick up everyday spoken English from Twitch streams.
You get about a minute of a stream's transcript, one numbered sentence per line. The transcript comes from speech
recognition, so expect small mistakes. Judge it for that learner:

- score, 0 to 10: how much natural, everyday spoken English it shows that is worth learning: phrasal verbs, idioms,
  casual connectors and fillers, typical spoken constructions ("I have to go down without dying", "it's just blown
  up", "figure it out"). Score low for reading chat aloud, lists, numbers, game-only jargon, or garbled text.
- expressions, at most 6: the parts worth learning. For each give "text", the exact words as they appear in one
  sentence; "key", a general form a learner would look up ("figure (something) out", "without + -ing",
  "it's just …"); "note", plain English, at most 12 words; and "sentence", that sentence's number.
- title: at most 8 words about what happens or is said.

Write everything in English."""

SCHEMA = {
    "type": "object",
    "properties": {
        "score": {"type": "integer"},
        "title": {"type": "string"},
        "expressions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "sentence": {"type": "integer"},
                    "text": {"type": "string"},
                    "key": {"type": "string"},
                    "note": {"type": "string"},
                },
                "required": ["sentence", "text", "key", "note"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["score", "title", "expressions"],
    "additionalProperties": False,
}


def _place(sentences: list[str], index: int, text: str) -> tuple[int, int, int] | None:
    """Where an expression sits: (sentence, start, end), trusting the words more than the number."""
    needle = text.strip().lower()
    if not needle:
        return None
    order = [index] + [i for i in range(len(sentences)) if i != index]
    for i in order:
        if 0 <= i < len(sentences):
            at = sentences[i].lower().find(needle)
            if at >= 0:
                return i, at, at + len(needle)
    return None


def by_rules(sentences: list[str], patterns: list[P.Pattern]) -> dict:
    """The phrase list's verdict: the phrases found, a score from how many (and how good), a title."""
    found, seen = [], set()
    for i, text in enumerate(sentences):
        for p, a, b in P.find(patterns, text):
            if p.id in seen:
                continue
            seen.add(p.id)
            found.append({"key": p.label, "text": text[a:b], "note": p.note, "sentence": i, "a": a, "b": b, "w": p.weight})
    score = min(10, round(sum(f["w"] for f in found) * 1.2))
    best = max(found, key=lambda f: f["w"], default=None)
    words = (sentences[best["sentence"]] if best else (sentences[0] if sentences else "")).split()
    title = " ".join(words[:8]) + ("…" if len(words) > 8 else "")
    return {"score": score, "title": title, "expressions": [{k: v for k, v in f.items() if k != "w"} for f in found[:8]]}


class Judge:
    """Judges moments one at a time in the background, with Claude when it can and by rules when it can't."""

    def __init__(self, app):
        self.app = app
        self.model = app.settings.ai_model
        self.error: str | None = None
        self._client = None
        self._q: queue.Queue = queue.Queue()
        if app.settings.ai_key:
            try:
                import anthropic

                self._anthropic = anthropic
                self._client = anthropic.Anthropic(api_key=app.settings.ai_key, max_retries=3, timeout=60)
            except Exception as error:  # the package missing, say
                self.error = f"{type(error).__name__}: {error}"
        threading.Thread(target=self._run, name="judge", daemon=True).start()

    @property
    def using_ai(self) -> bool:
        return self._client is not None

    def status(self) -> dict:
        return {"model": self.model if self.using_ai else None, "error": self.error, "waiting": self._q.qsize()}

    def add(self, moment_id: str) -> None:
        self._q.put(moment_id)

    def _run(self) -> None:
        for mid in self.app.library.unjudged_moments():  # left over from before a restart
            self._q.put(mid)
        if self.using_ai:  # a key was added: Claude looks again at what the rules judged (while the video is still there)
            for mid in self.app.library.rule_judged_with_clips():
                self._q.put(mid)
        while True:
            mid = self._q.get()
            try:
                self._judge(mid)
            except Exception as error:
                self.error = f"{type(error).__name__}: {error}"[:300]

    def _judge(self, mid: str) -> None:
        lib = self.app.library
        m = lib.moment_for_judging(mid)
        if not m:
            return
        sentences = [s["text"] for s in m["sentences"]]
        verdict, how = None, 2
        if self._client is not None:
            verdict = self._ask_claude(m, sentences)
            if verdict is not None:
                how = 1
        if verdict is None:
            verdict = by_rules(sentences, self.app.patterns())
        pick = verdict["score"] >= (PICK_AI if how == 1 else PICK_RULES)
        lib.judged(mid, verdict["title"], verdict["score"], pick, verdict["expressions"], how)
        if pick and self.app.sync:
            self.app.sync.poke()

    def _ask_claude(self, m: dict, sentences: list[str]) -> dict | None:
        a = self._anthropic
        lines = "\n".join(f"{i + 1}. {t}" for i, t in enumerate(sentences))
        where = " · ".join(x for x in (m.get("displayName"), m.get("category")) if x)
        for attempt in range(4):
            try:
                response = self._client.messages.create(
                    model=self.model,
                    max_tokens=8000,
                    system=SYSTEM,
                    messages=[{"role": "user", "content": f"Stream: {where}\n\n{lines}"}],
                    output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
                )
            except a.AuthenticationError:
                self.error = "the Anthropic API key was rejected"
                self._client = None  # rules from now on, until the key is fixed and Earmark restarts
                return None
            except a.PermissionDeniedError as error:
                self.error = f"Anthropic: {error.message}"[:300]
                return None
            except (a.BadRequestError, a.NotFoundError) as error:
                self.error = f"Anthropic: {error.message}"[:300]
                return None
            except (a.RateLimitError, a.InternalServerError, a.APIConnectionError, a.APIStatusError) as error:
                self.error = f"Anthropic: {type(error).__name__}"
                time.sleep(15 * (attempt + 1))
                continue
            if response.stop_reason == "refusal":
                return None
            text = next((b.text for b in response.content if b.type == "text"), None)
            if not text:
                return None
            try:
                data = json.loads(text)
            except ValueError:
                return None
            self.error = None
            out = []
            for e in data.get("expressions") or []:
                where_ = _place(sentences, int(e.get("sentence", 0)) - 1, str(e.get("text", "")))
                if where_ is None:
                    continue  # words that aren't in the transcript: skip
                i, start, end = where_
                out.append({"key": str(e.get("key", "")).strip()[:80] or sentences[i][start:end],
                            "text": sentences[i][start:end], "note": str(e.get("note", "")).strip()[:160],
                            "sentence": i, "a": start, "b": end})
            return {"score": max(0, min(10, int(data.get("score", 0)))), "title": str(data.get("title", "")).strip()[:80],
                    "expressions": out[:6]}
        return None
