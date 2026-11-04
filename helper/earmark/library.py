"""Everything Earmark keeps: streams watched, phrases caught, and the clips they came with.

One SQLite file plus a media folder. `export()` gives the whole library as the JSON
the dashboard reads, locally and in the cloud copy.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

from .categories import classify
from .patterns import Pattern

SCHEMA = """
create table if not exists sessions (
  id text primary key,
  channel text not null,
  display_name text,
  category text,
  title text,
  tags text,
  kind text not null default 'live',
  vod_id text,
  vod_offset real,
  started_at real not null,
  ended_at real,
  heard real not null default 0,
  words integer not null default 0
);
create table if not exists catches (
  id text primary key,
  session_id text not null references sessions(id) on delete cascade,
  pattern text not null,
  sentence text not null,
  match_start integer not null,
  match_end integer not null,
  words text,
  t0 real not null,
  t1 real not null,
  at real not null,
  clip text,
  poster text,
  duration real,
  starred integer not null default 0,
  synced integer not null default 0
);
create index if not exists catches_pattern on catches(pattern);
create index if not exists catches_session on catches(session_id);
create index if not exists catches_clip on catches(clip);
create table if not exists channels (
  login text primary key,
  display_name text,
  group_override text
);
create table if not exists custom_patterns (
  id text primary key,
  label text not null,
  regex text not null,
  kind text,
  note text,
  created_at real not null
);
"""


def vod_link(vod_id: str | None, offset: float | None, t: float) -> str | None:
    if not vod_id or offset is None:
        return None
    s = max(0, int(offset + t - 2))
    return f"https://www.twitch.tv/videos/{vod_id}?t={s // 3600}h{s // 60 % 60}m{s % 60}s"


class Library:
    def __init__(self, path: Path, media: Path):
        self.media = media
        media.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        self.changed_at = time.time()
        with self._lock:
            self._db.execute("pragma journal_mode=wal")
            self._db.execute("pragma foreign_keys=on")
            self._db.executescript(SCHEMA)

    def _run(self, sql: str, args: tuple = ()) -> sqlite3.Cursor:
        with self._lock:
            return self._db.execute(sql, args)

    def _touch(self) -> None:
        self.changed_at = time.time()

    # streams --------------------------------------------------------------
    def add_session(self, s: dict) -> None:
        self._run(
            "insert into sessions (id, channel, display_name, category, title, tags, kind, vod_id, vod_offset, started_at)"
            " values (?,?,?,?,?,?,?,?,?,?)",
            (s["id"], s["channel"], s.get("displayName"), s.get("category"), s.get("title"),
             json.dumps(s.get("tags") or []), s.get("kind") or "live", s.get("vodId"), s.get("vodOffset"),
             s["startedAt"]),
        )
        self._run(
            "insert into channels (login, display_name) values (?, ?)"
            " on conflict(login) do update set display_name = coalesce(excluded.display_name, display_name)",
            (s["channel"], s.get("displayName")),
        )
        self._touch()

    def update_session(self, sid: str, **fields) -> None:
        cols = {"category": "category", "title": "title", "tags": "tags", "endedAt": "ended_at",
                "heard": "heard", "words": "words", "displayName": "display_name"}
        sets, args = [], []
        for key, value in fields.items():
            if key in cols:
                sets.append(f"{cols[key]} = ?")
                args.append(json.dumps(value) if key == "tags" else value)
        if sets:
            self._run(f"update sessions set {', '.join(sets)} where id = ?", (*args, sid))
            self._touch()

    def set_channel_group(self, login: str, group: str | None) -> None:
        self._run(
            "insert into channels (login, group_override) values (?, ?)"
            " on conflict(login) do update set group_override = excluded.group_override",
            (login, group),
        )
        self._touch()

    # phrases --------------------------------------------------------------
    def add_catch(self, c: dict) -> None:
        self._run(
            "insert into catches (id, session_id, pattern, sentence, match_start, match_end, words, t0, t1, at, duration)"
            " values (?,?,?,?,?,?,?,?,?,?,?)",
            (c["id"], c["sessionId"], c["pattern"], c["sentence"], c["match"][0], c["match"][1],
             json.dumps(c["words"]), c["t0"], c["t1"], c["at"], c["t1"] - c["t0"]),
        )
        self._touch()

    def attach_clip(self, ids: list[str], clip: str | None, poster: str | None) -> None:
        with self._lock:
            for cid in ids:
                self._db.execute("update catches set clip = ?, poster = ? where id = ?", (clip, poster, cid))
        self._touch()

    def count(self, pattern: str, channel: str, with_clip: bool) -> int:
        row = self._run(
            "select count(*) from catches c join sessions s on s.id = c.session_id"
            " where c.pattern = ? and s.channel = ?" + (" and c.clip is not null" if with_clip else ""),
            (pattern, channel),
        ).fetchone()
        return row[0]

    def seen_sentence(self, pattern: str, channel: str, sentence: str) -> bool:
        row = self._run(
            "select 1 from catches c join sessions s on s.id = c.session_id"
            " where c.pattern = ? and s.channel = ? and lower(c.sentence) = lower(?) limit 1",
            (pattern, channel, sentence),
        ).fetchone()
        return row is not None

    def update_catch(self, cid: str, starred: bool | None = None) -> bool:
        if starred is None:
            return False
        cur = self._run("update catches set starred = ? where id = ?", (int(starred), cid))
        self._touch()
        return cur.rowcount > 0

    def delete_catch(self, cid: str) -> bool:
        with self._lock:
            row = self._db.execute("select clip, poster from catches where id = ?", (cid,)).fetchone()
            if not row:
                return False
            self._db.execute("delete from catches where id = ?", (cid,))
            for rel in (row["clip"], row["poster"]):
                if rel and not self._db.execute(
                    "select 1 from catches where clip = ? or poster = ? limit 1", (rel, rel)
                ).fetchone():
                    (self.media / rel).unlink(missing_ok=True)
        self._touch()
        return True

    # sync bookkeeping -----------------------------------------------------
    def unsynced_clips(self, limit: int) -> list[sqlite3.Row]:
        """Starred first, then newest: if the daily allowance runs out, old clips wait."""
        return self._run(
            "select clip, max(starred) as starred, max(at) as at from catches where clip is not null and synced = 0"
            " group by clip order by max(starred) desc, max(at) desc limit ?",
            (limit,),
        ).fetchall()

    def skip_stale_clips(self, before: float) -> None:
        self._run("update catches set synced = 3 where synced = 0 and starred = 0 and clip is not null and at < ?",
                  (before,))

    def mark_synced(self, clip: str, state: int = 1) -> None:
        self._run("update catches set synced = ? where clip = ?", (state, clip))

    def synced_clips_oldest_first(self) -> list[sqlite3.Row]:
        return self._run(
            "select clip, max(starred) as starred, min(at) as at from catches where synced = 1 and clip is not null"
            " group by clip order by max(starred), min(at)"
        ).fetchall()

    # your own phrases -----------------------------------------------------
    def custom_patterns(self) -> list[dict]:
        return [dict(r) for r in self._run("select * from custom_patterns order by created_at").fetchall()]

    def add_pattern(self, row: dict) -> None:
        self._run(
            "insert into custom_patterns (id, label, regex, kind, note, created_at) values (?,?,?,?,?,?)",
            (row["id"], row["label"], row["regex"], row.get("kind"), row.get("note"), time.time()),
        )
        self._touch()

    def delete_pattern(self, pid: str) -> bool:
        cur = self._run("delete from custom_patterns where id = ?", (pid,))
        self._touch()
        return cur.rowcount > 0

    # the whole thing, as the dashboard reads it -----------------------------
    def export(self, patterns: list[Pattern], cloud: bool = False) -> dict:
        with self._lock:
            channels = {r["login"]: dict(r) for r in self._db.execute("select * from channels")}
            sessions = [dict(r) for r in self._db.execute("select * from sessions order by started_at")]
            catches = [dict(r) for r in self._db.execute("select * from catches order by at")]
        out_sessions = {}
        for s in sessions:
            tags = json.loads(s["tags"] or "[]")
            group, game = classify(s["category"], s["title"], tags)
            override = (channels.get(s["channel"]) or {}).get("group_override")
            if override:
                group = override
            out_sessions[s["id"]] = {
                "id": s["id"],
                "channel": s["channel"],
                "displayName": s["display_name"] or s["channel"],
                "category": s["category"],
                "group": group,
                "game": game if group == "gaming" else None,
                "title": s["title"],
                "kind": s["kind"],
                "startedAt": s["started_at"],
                "endedAt": s["ended_at"],
                "heard": round(s["heard"] or 0, 1),
                "words": s["words"] or 0,
            }
        vods = {s["id"]: (s["vod_id"], s["vod_offset"]) for s in sessions}
        out_catches = []
        for c in catches:
            if c["session_id"] not in out_sessions:
                continue
            vod_id, offset = vods[c["session_id"]]
            item = {
                "id": c["id"],
                "sessionId": c["session_id"],
                "pattern": c["pattern"],
                "sentence": c["sentence"],
                "match": [c["match_start"], c["match_end"]],
                "words": json.loads(c["words"] or "null"),
                "at": c["at"],
                "duration": round(c["duration"] or 0, 2),
                "clip": c["clip"],
                "poster": c["poster"],
                "starred": bool(c["starred"]),
                "vod": vod_link(vod_id, offset, c["t0"]),
            }
            if cloud:
                # the cloud copy holds clips only (posters would double the uploads),
                # and only the ones already uploaded
                item["poster"] = None
                if c["synced"] != 1:
                    item["clip"] = None
            out_catches.append(item)
        return {
            "version": 1,
            "generatedAt": time.time(),
            "patterns": [p.public() for p in patterns],
            "sessions": list(out_sessions.values()),
            "catches": out_catches,
            "channels": [
                {"login": k, "displayName": v["display_name"] or k, "group": v["group_override"]}
                for k, v in channels.items()
            ],
        }
