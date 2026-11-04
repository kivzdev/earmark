"""The phrases Earmark listens for: everyday connectors, frames, markers and verbs.

The built-in list lives in patterns.json. Anyone can add their own from the
dashboard: plain words ("which is"), `…` or `___` for "anything here", or a raw
regular expression that starts with `re:`.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

KINDS = ("connector", "frame", "marker", "verb", "expression")


@dataclass(frozen=True)
class Pattern:
    id: str
    label: str
    regex: re.Pattern
    kind: str
    weight: int
    note: str = ""
    example: str = ""
    custom: bool = False

    def public(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "kind": self.kind,
            "weight": self.weight,
            "note": self.note,
            "example": self.example,
            "custom": self.custom,
        }


def _compile(source: str) -> re.Pattern:
    return re.compile(source, re.IGNORECASE)


def builtin() -> list[Pattern]:
    rows = json.loads((Path(__file__).with_name("patterns.json")).read_text(encoding="utf-8"))
    return [
        Pattern(r["id"], r["label"], _compile(r["re"]), r["kind"], int(r["weight"]), r.get("note", ""), r.get("example", ""))
        for r in rows
    ]


WILDCARD = re.compile(r"\s*(?:…|\.\.\.|_{2,}|\*)\s*")


def phrase_to_regex(phrase: str) -> str:
    """'which is' → \\bwhich is\\b · 'end up …ing' → \\bend up\\b.{0,40}?ing\\b"""
    phrase = phrase.strip()
    if phrase.startswith("re:"):
        return phrase[3:].strip()
    parts = [p for p in WILDCARD.split(phrase.replace("’", "'"))]
    pieces = []
    for part in parts:
        words = part.split()
        pieces.append(r"\s+".join(re.escape(w).replace("'", "['’]") for w in words))
    body = r"\b.{0,40}?\b".join(p for p in pieces if p)
    if not body:
        raise ValueError("empty phrase")
    return rf"\b{body}\b"


def custom(rows: list[dict]) -> list[Pattern]:
    out = []
    for r in rows:
        try:
            regex = _compile(r["regex"])
        except re.error:
            continue
        out.append(Pattern(r["id"], r["label"], regex, r.get("kind") or "frame", 3, r.get("note") or "", "", True))
    return out


def find(patterns: list[Pattern], text: str) -> list[tuple[Pattern, int, int]]:
    """Every pattern found in `text`, with the character span of its first match."""
    text = text.replace("’", "'")
    hits = []
    for p in patterns:
        m = p.regex.search(text)
        if m and m.end() > m.start():
            hits.append((p, m.start(), m.end()))
    return hits
