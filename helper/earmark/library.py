"""Everything Earmark keeps: the streams you watched, cut into one-minute moments with their transcript and video,
the moments worth keeping, and the expressions in them.

One SQLite file plus a media folder. `export()` gives the whole library as the JSON the dashboard reads, locally and
in the online copy.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

from .categories import classify

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
create table if not exists channels (
  login text primary key,
  display_name text,
  group_override text,
  avatar text
);
create table if not exists categories (
  name text primary key,
  box_art text,
  updated real
);
create table if not exists moments (
  id text primary key,
  session_id text not null references sessions(id) on delete cascade,
  t0 real not null,
  t1 real not null,
  at real not null,
  sentences text not null,
  clip text,
  poster text,
  thumb text,
  title text,
  score real,
  picked integer not null default 0,
  starred integer not null default 0,
  judged integer not null default 0,
  synced integer not null default 0
);
create index if not exists moments_session on moments(session_id);
create index if not exists moments_at on moments(at);
create table if not exists expressions (
  moment_id text not null references moments(id) on delete cascade,
  key text not null,
  text text not null,
  note text,
  sentence integer not null,
  a integer not null,
  b integer not null
);
create index if not exists expressions_moment on expressions(moment_id);
create index if not exists expressions_key on expressions(key);
create table if not exists custom_patterns (
  id text primary key,
  label text not null,
  regex text not null,
  kind text,
  note text,
  created_at real not null
);
"""

# the first version kept one clip per caught phrase; moments replaced it
MIGRATE = ["drop table if exists catches", "alter table channels add column avatar text",
           "alter table sessions add column vod_marks text", "alter table moments add column cloud_bytes integer",
           "alter table moments add column low text", "alter table moments add column clip_h integer"]

# what of a moment the online copy holds, by its sync state (sync.py): 2 its clip in both sizes, 1 the 360p one,
# 0 its picture and transcript; 0 waits to go up, 2 (an old state) and 3 were never or are no longer there
CLOUD_LEVEL = {1: 2, 4: 1, 5: 0}


def vod_link(vod_id: str | None, marks: list, t: float) -> str | None:
    """The VOD at the moment's start: from the last place the player was put before it ([stream time, VOD time])."""
    if not vod_id or not marks:
        return None
    stream_t, vod_t = max((m for m in marks if m[0] <= t + 0.5), key=lambda m: m[0], default=marks[0])
    s = max(0, int(vod_t + t - stream_t - 2))
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
            for sql in MIGRATE:
                try:
                    self._db.execute(sql)
                except sqlite3.OperationalError:
                    pass  # already done

    def _run(self, sql: str, args: tuple = ()) -> sqlite3.Cursor:
        with self._lock:
            return self._db.execute(sql, args)

    def _touch(self) -> None:
        self.changed_at = time.time()

    # streams ----------------------------------------------------------------------------------------------------
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
                "heard": "heard", "words": "words", "displayName": "display_name", "channel": "channel"}
        sets, args = [], []
        for key, value in fields.items():
            if key in cols:
                sets.append(f"{cols[key]} = ?")
                args.append(json.dumps(value) if key == "tags" else value)
        if sets:
            self._run(f"update sessions set {', '.join(sets)} where id = ?", (*args, sid))
            self._touch()

    def add_vod_mark(self, sid: str, stream_t: float, vod_t: float) -> None:
        with self._lock:
            row = self._db.execute("select vod_marks, vod_offset from sessions where id = ?", (sid,)).fetchone()
            if not row:
                return
            marks = json.loads(row["vod_marks"] or "null") or ([[0.0, row["vod_offset"]]] if row["vod_offset"] is not None else [])
            marks.append([round(stream_t, 2), round(vod_t, 2)])
            self._db.execute("update sessions set vod_marks = ? where id = ?", (json.dumps(marks[-500:]), sid))

    def vods_to_resolve(self) -> list[sqlite3.Row]:
        return self._run("select id, vod_id from sessions where kind = 'vod' and vod_id is not null"
                         " and (category is null or category = '' or title is null)").fetchall()

    def set_channel_group(self, login: str, group: str | None) -> None:
        self._run(
            "insert into channels (login, group_override) values (?, ?)"
            " on conflict(login) do update set group_override = excluded.group_override",
            (login, group),
        )
        self._touch()

    def set_channel_avatar(self, login: str, avatar: str | None, display_name: str | None = None) -> None:
        self._run(
            "insert into channels (login, avatar, display_name) values (?, ?, ?) on conflict(login) do update set"
            " avatar = coalesce(excluded.avatar, avatar), display_name = coalesce(excluded.display_name, display_name)",
            (login, avatar, display_name),
        )
        self._touch()

    def set_box_art(self, category: str, url: str | None) -> None:
        self._run(
            "insert into categories (name, box_art, updated) values (?, ?, ?)"
            " on conflict(name) do update set box_art = excluded.box_art, updated = excluded.updated",
            (category, url, time.time()),
        )
        self._touch()

    def needs_art(self) -> tuple[list[str], list[str]]:
        """Categories without box art and channels without an avatar."""
        cats = [r[0] for r in self._run(
            "select distinct s.category from sessions s left join categories c on c.name = s.category"
            " where s.category is not null and (c.box_art is null or c.box_art = '')").fetchall()]
        chans = [r[0] for r in self._run("select login from channels where avatar is null or avatar = ''").fetchall()]
        return cats, chans

    # moments ----------------------------------------------------------------------------------------------------
    def add_moment(self, m: dict) -> None:
        self._run(
            "insert into moments (id, session_id, t0, t1, at, sentences) values (?,?,?,?,?,?)",
            (m["id"], m["sessionId"], m["t0"], m["t1"], m["at"], json.dumps(m["sentences"], separators=(",", ":"))),
        )
        self._touch()

    def attach_media(self, mid: str, clip: str | None, poster: str | None, thumb: str | None, low: str | None = None,
                     height: int | None = None) -> None:
        self._run("update moments set clip = ?, poster = ?, thumb = ?, low = ?, clip_h = ? where id = ?",
                  (clip, poster, thumb, low, height, mid))
        self._touch()

    def rule_judged_with_clips(self) -> list[str]:
        return [r[0] for r in self._run("select id from moments where judged = 2 and clip is not null order by at").fetchall()]

    def unjudged_moments(self) -> list[str]:
        return [r[0] for r in self._run("select id from moments where judged = 0 order by at").fetchall()]

    def moment_for_judging(self, mid: str) -> dict | None:
        row = self._run(
            "select m.sentences, s.display_name, s.channel, s.category from moments m join sessions s on s.id = m.session_id"
            " where m.id = ?", (mid,)).fetchone()
        if not row:
            return None
        return {"sentences": json.loads(row["sentences"]), "displayName": row["display_name"] or row["channel"],
                "category": row["category"]}

    def judged(self, mid: str, title: str, score: float, picked: bool, expressions: list[dict], how: int) -> None:
        with self._lock:
            self._db.execute("delete from expressions where moment_id = ?", (mid,))
            for e in expressions:
                self._db.execute(
                    "insert into expressions (moment_id, key, text, note, sentence, a, b) values (?,?,?,?,?,?,?)",
                    (mid, e["key"], e["text"], e.get("note") or "", e["sentence"], e["a"], e["b"]))
            self._db.execute("update moments set title = ?, score = ?, picked = ?, judged = ? where id = ?",
                             (title, score, int(picked), how, mid))
        self._touch()

    def star(self, mid: str, starred: bool) -> bool:
        cur = self._run("update moments set starred = ? where id = ?", (int(starred), mid))
        self._touch()
        return cur.rowcount > 0

    def delete_moment(self, mid: str) -> bool:
        with self._lock:
            row = self._db.execute("select clip, low, poster, thumb from moments where id = ?", (mid,)).fetchone()
            if not row:
                return False
            self._db.execute("delete from moments where id = ?", (mid,))
        for rel in row:
            if rel:
                (self.media / rel).unlink(missing_ok=True)
        self._touch()
        return True

    def recent_moments(self, session_id: str, n: int = 5) -> list[dict]:
        rows = self._run("select id, title, picked, at, sentences from moments where session_id = ? order by at desc limit ?",
                         (session_id, n)).fetchall()
        out = []
        for r in rows:
            first = (json.loads(r["sentences"]) or [{"text": ""}])[0]["text"]
            exprs = [e[0] for e in self._run("select text from expressions where moment_id = ?", (r["id"],)).fetchall()]
            out.append({"id": r["id"], "title": r["title"], "picked": bool(r["picked"]), "at": r["at"], "first": first,
                        "expressions": exprs[:4]})
        return out

    def forget_old_media(self, before: float) -> int:
        """Drop the video of moments nobody kept once they're old; their transcript stays."""
        with self._lock:
            rows = self._db.execute(
                "select id, clip, low, poster, thumb from moments where picked = 0 and starred = 0 and at < ?"
                " and clip is not null", (before,)).fetchall()
            for r in rows:
                self._db.execute("update moments set clip = null, low = null, poster = null, thumb = null where id = ?",
                                 (r["id"],))
        for r in rows:
            for rel in (r["clip"], r["low"], r["poster"], r["thumb"]):
                if rel:
                    (self.media / rel).unlink(missing_ok=True)
        if rows:
            self._touch()
        return len(rows)

    # the online copy's bookkeeping -------------------------------------------------------------------------------
    def unsynced_kept(self, limit: int) -> list[sqlite3.Row]:
        """Kept moments not uploaded yet: starred first, then newest."""
        return self._run(
            "select id, clip, low, thumb from moments where (picked = 1 or starred = 1) and clip is not null"
            " and synced = 0"
            " order by starred desc, at desc limit ?", (limit,)).fetchall()

    def mark_synced(self, mid: str, state: int = 1, size: int | None = None) -> None:
        if size is None:
            self._run("update moments set synced = ? where id = ?", (state, mid))
        else:
            self._run("update moments set synced = ?, cloud_bytes = ? where id = ?", (state, size, mid))

    def in_cloud(self) -> list[sqlite3.Row]:
        """Moments with something online: starred first, then newest first."""
        return self._run("select id, clip, low, thumb, starred, synced from moments"
                         " where synced in (1, 4, 5) and clip is not null order by starred desc, at desc").fetchall()

    def skip_stale(self, before: float) -> None:
        self._run("update moments set synced = 3 where synced = 0 and starred = 0 and at < ?", (before,))

    # your own phrases (for the rules) -----------------------------------------------------------------------------
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

    # the whole thing, as the dashboard reads it --------------------------------------------------------------------
    def export(self, cloud: bool = False, levels: dict[str, int] | None = None) -> dict:
        """The library as the dashboard reads it. `cloud`: as the online copy holds it, with `levels` (moment → sync
        state) for what's about to change there."""
        with self._lock:
            channels = {r["login"]: dict(r) for r in self._db.execute("select * from channels")}
            arts = {r["name"]: r["box_art"] for r in self._db.execute("select * from categories")}
            sessions = [dict(r) for r in self._db.execute("select * from sessions order by started_at")]
            if cloud:  # the copy carries every starred moment and the newest kept ones (its upload has a size limit)
                moments = [dict(r) for r in self._db.execute(
                    "select * from moments where starred = 1 or id in"
                    " (select id from moments where picked = 1 order by at desc limit 250) order by at")]
            else:
                moments = [dict(r) for r in self._db.execute("select * from moments order by at")]
            exprs: dict[str, list] = {}
            for r in self._db.execute("select * from expressions"):
                exprs.setdefault(r["moment_id"], []).append(
                    {"key": r["key"], "text": r["text"], "note": r["note"], "s": r["sentence"], "a": r["a"], "b": r["b"]})
        out_sessions = {}
        for s in sessions:
            group, game = classify(s["category"], s["title"], json.loads(s["tags"] or "[]"))
            override = (channels.get(s["channel"]) or {}).get("group_override")
            out_sessions[s["id"]] = {
                "id": s["id"], "channel": s["channel"], "displayName": s["display_name"] or s["channel"],
                "category": s["category"], "group": override or group, "game": game if (override or group) == "gaming" else None,
                "title": s["title"], "kind": s["kind"], "vodId": s["vod_id"],
                "startedAt": s["started_at"], "endedAt": s["ended_at"], "heard": round(s["heard"] or 0, 1),
                "words": s["words"] or 0,
            }
        vods = {s["id"]: (s["vod_id"], json.loads(s.get("vod_marks") or "null")
                           or ([[0.0, s["vod_offset"]]] if s["vod_offset"] is not None else [])) for s in sessions}
        out_moments = []
        for m in moments:
            if m["session_id"] not in out_sessions:
                continue
            item = {
                "id": m["id"], "sessionId": m["session_id"], "at": m["at"], "duration": round(m["t1"] - m["t0"], 1),
                "title": m["title"], "score": m["score"], "picked": bool(m["picked"]), "starred": bool(m["starred"]),
                "judged": m["judged"], "clip": m["clip"], "low": m["low"], "clipH": m["clip_h"], "poster": m["poster"],
                "vod": vod_link(*vods[m["session_id"]], m["t0"]),
                "sentences": json.loads(m["sentences"]), "expressions": exprs.get(m["id"], []),
            }
            item["thumb"] = m["thumb"]
            if cloud:  # the copy holds what's online of the moment (no posters: its player shows the clip's own frame)
                level = CLOUD_LEVEL.get((levels or {}).get(m["id"], m["synced"]), -1)
                item["clip"] = m["clip"] if level == 2 else None
                item["low"] = m["low"] if level >= 1 else None
                item["poster"] = None
                item["thumb"] = m["thumb"] if level >= 0 else None
            out_moments.append(item)
        if cloud:  # streams the copy has moments from, or that were watched in the last month
            keep = {m["sessionId"] for m in out_moments}
            month = time.time() - 31 * 86400
            out_sessions = {k: v for k, v in out_sessions.items() if k in keep or v["startedAt"] > month}
        cats = sorted({s["category"] for s in out_sessions.values() if s["category"]})
        return {
            "version": 2,
            "generatedAt": time.time(),
            "sessions": list(out_sessions.values()),
            "moments": out_moments,
            "channels": [{"login": k, "displayName": v["display_name"] or k, "group": v["group_override"],
                          "avatar": v.get("avatar")} for k, v in channels.items()],
            "categories": [{"name": c, "boxArt": arts.get(c)} for c in cats],
        }
