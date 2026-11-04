"""Optional cloud copy of the library (the `/cloud` app in this repository).

The moments worth keeping are uploaded newest first (starred ones before): the clip in both sizes (720p and 360p) and
its thumbnail. Every file and every snapshot of the library counts against a day's uploads (50 by default: in any month
well under the 2,000 Vercel's free plan includes, and going over it locks the storage for 30 days); what doesn't fit
waits for the next day. When the copy grows past its budget, older moments step down to the 360p clip, then to their
thumbnail and transcript. Your own computer keeps everything; the cloud only mirrors it.
"""

from __future__ import annotations

import gzip
import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date

from .library import CLOUD_LEVEL

SMALL = 4 * 1024 * 1024  # what one request to the copy may carry (Vercel stops at 4.5 MB); bigger files go to its storage
STATE = {level: state for state, level in CLOUD_LEVEL.items()}
SNAPSHOT_EVERY = 1800  # seconds between snapshots of a library that keeps changing
FOR_SNAPSHOTS = 10  # of a day's uploads, kept for the snapshots


class Sync:
    def __init__(self, app):
        self.app = app
        s = app.settings
        self.url = s.sync_url
        self._token = s.sync_token
        self._path = s.home / "sync.json"
        self.state = {"day": "", "uploaded": 0, "snapshotAt": 0.0, "lastOk": 0.0, "error": None}
        try:
            self.state.update(json.loads(self._path.read_text()))
        except (OSError, ValueError):
            pass
        self._wake = threading.Event()
        self._snapshot_due = True
        threading.Thread(target=self._run, name="sync", daemon=True).start()

    def poke(self, snapshot: bool = False) -> None:
        if snapshot:
            self._snapshot_due = True
        self._wake.set()

    def status(self) -> dict:
        return {
            "url": self.url,
            "uploadedToday": self.state["uploaded"] if self.state["day"] == date.today().isoformat() else 0,
            "perDay": self.app.settings.sync_uploads_per_day,
            "lastOk": self.state["lastOk"],
            "error": self.state["error"],
        }

    def _save(self) -> None:
        try:
            self._path.write_text(json.dumps(self.state))
        except OSError:
            pass

    def _call(self, method: str, path: str, body: bytes = b"", headers: dict | None = None) -> int:
        return self._ask(method, path, body, headers)[0]

    def _ask(self, method: str, path: str, body: bytes = b"", headers: dict | None = None) -> tuple[int, dict]:
        request = urllib.request.Request(
            self.url + path,
            data=body if method in ("PUT", "POST") else None,
            method=method,
            headers={"Authorization": f"Bearer {self._token}", "User-Agent": "earmark", **(headers or {})},
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                raw = response.read()
                try:
                    return response.status, json.loads(raw or b"{}")
                except ValueError:
                    return response.status, {}
        except urllib.error.HTTPError as error:
            return error.code, {}

    def _put(self, rel: str, path, kind: str) -> int:
        """One file up; a big one straight to the copy's storage, on a link the copy signs for it alone."""
        body = path.read_bytes()
        self.state["uploaded"] += 1  # (counted as tried: storage may have taken it even when the answer is lost)
        where = urllib.parse.quote(rel)
        if len(body) > SMALL:
            code, ticket = self._ask("POST", f"/api/sync/upload?path={where}&size={len(body)}")
            if code == 200 and str(ticket.get("url", "")).startswith("https://"):
                # (the storage's own address: the sync token isn't sent there)
                request = urllib.request.Request(ticket["url"], data=body, method="PUT",
                                                 headers={**ticket.get("headers", {}), "User-Agent": "earmark"})
                try:
                    with urllib.request.urlopen(request, timeout=300) as response:
                        code = response.status
                except urllib.error.HTTPError as error:
                    code = error.code
                if code != 200:
                    raise RuntimeError(f"{rel}: the storage answered {code}")
                # (it went past the copy: ask it to read the file back the way a player will)
                code, held = self._ask("GET", f"/api/sync/check?path={where}")
                if code != 200 or held.get("size") != len(body):
                    raise RuntimeError(f"{rel}: the storage holds {held.get('size')} of {len(body)} bytes")
                return len(body)
            if code != 501:  # 501: storage without signed links (a folder), which takes it the usual way
                raise RuntimeError(f"{rel}: the upload link answered {code}")
        code = self._call("PUT", "/api/sync/clip?path=" + where, body, {"Content-Type": kind})
        if code != 200:
            raise RuntimeError(f"{rel}: the upload answered {code}")
        return len(body)

    def _run(self) -> None:
        time.sleep(5)
        while True:
            try:
                self._round()
                self.state["error"] = None
                self.state["lastOk"] = time.time()
            except Exception as error:
                self.state["error"] = f"{type(error).__name__}: {error}"[:300]
            self._save()
            self._wake.wait(60)
            self._wake.clear()

    def _round(self) -> None:
        lib, s = self.app.library, self.app.settings
        today = date.today().isoformat()
        if self.state["day"] != today:
            self.state.update(day=today, uploaded=0)
        lib.skip_stale(time.time() - 7 * 86400)
        # new moments, while the day's uploads last
        for row in lib.unsynced_kept(100):
            if not (s.media / row["clip"]).is_file():
                lib.mark_synced(row["id"], 3)
                continue
            files = [(rel, kind) for rel, kind in ((row["clip"], "video/mp4"), (row["low"], "video/mp4"),
                                                   (row["thumb"], "image/jpeg")) if rel and (s.media / rel).is_file()]
            if self.state["uploaded"] + len(files) > s.sync_uploads_per_day - FOR_SNAPSHOTS:
                break
            size = sum(self._put(rel, s.media / rel, kind) for rel, kind in files)
            lib.mark_synced(row["id"], 1, size)
        # a snapshot of the library every half hour while it changes, and soon after a stream ends; what the budget
        # no longer holds is let go once the snapshot that doesn't show it is up
        plan = self._fit()
        since = time.time() - self.state["snapshotAt"]
        stale = lib.changed_at > self.state["snapshotAt"] or bool(plan)
        due = not self.state["snapshotAt"] or since > SNAPSHOT_EVERY or (self._snapshot_due and since > 120)
        if not (stale and due and self.state["uploaded"] < s.sync_uploads_per_day):
            return
        levels = {mid: state for mid, state, _ in plan}
        body = gzip.compress(json.dumps(lib.export(cloud=True, levels=levels), separators=(",", ":")).encode())
        self.state["uploaded"] += 1
        code = self._call("PUT", "/api/sync/library", body, {"Content-Type": "application/json", "Content-Encoding": "gzip"})
        if code != 200:
            raise RuntimeError(f"library upload answered {code}")
        self.state["snapshotAt"] = time.time()
        self._snapshot_due = False
        for mid, state, gone in plan:
            for rel in gone:
                code = self._call("DELETE", "/api/sync/clip?path=" + urllib.parse.quote(rel))
                if code not in (200, 404):
                    raise RuntimeError(f"{rel}: the delete answered {code}")
            lib.mark_synced(mid, state)

    def _fit(self) -> list[tuple[str, int, list[str]]]:
        """What the copy lets go of to stay inside its budget, as (moment, its new sync state, files to delete): the
        newest moments keep both sizes in the first half of it, starred ones anywhere in it; older ones step down to the
        360p clip, then to their thumbnail and transcript."""
        lib, s = self.app.library, self.app.settings
        budget = s.sync_budget_mb * 1024 * 1024

        def size(rel):
            return (s.media / rel).stat().st_size if rel and (s.media / rel).is_file() else 0

        used, plan = 0, []
        for r in lib.in_cloud():
            have = CLOUD_LEVEL[r["synced"]]
            cost = {2: size(r["clip"]) + size(r["low"]) + size(r["thumb"]), 1: size(r["low"]) + size(r["thumb"]),
                    0: size(r["thumb"])}
            if have == 2 and used + cost[2] <= (budget if r["starred"] or not r["low"] else budget / 2):
                level = 2  # (a clip with no 360p copy is all the video it has)
            elif have >= 1 and r["low"] and used + cost[1] <= budget:
                level = 1
            else:
                level = 0
            used += cost[level]
            if level < have:
                gone = ([r["clip"]] if have == 2 else []) + ([r["low"]] if level == 0 else [])
                plan.append((r["id"], STATE[level], [rel for rel in gone if rel]))
        return plan
