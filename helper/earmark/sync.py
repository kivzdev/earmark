"""Optional cloud copy of the library (the `/cloud` app in this repository).

Clips are uploaded newest first, a few dozen a day at most, and the oldest ones
are removed from the cloud again when the copy grows past its budget. Your own
computer keeps everything; the cloud only mirrors it.
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
            "perDay": self.app.settings.sync_clips_per_day,
            "lastOk": self.state["lastOk"],
            "error": self.state["error"],
        }

    def _save(self) -> None:
        try:
            self._path.write_text(json.dumps(self.state))
        except OSError:
            pass

    def _call(self, method: str, path: str, body: bytes = b"", headers: dict | None = None) -> int:
        request = urllib.request.Request(
            self.url + path,
            data=body if method in ("PUT", "POST") else None,
            method=method,
            headers={"Authorization": f"Bearer {self._token}", "User-Agent": "earmark", **(headers or {})},
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return response.status
        except urllib.error.HTTPError as error:
            return error.code

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
        app, lib, s = self.app, self.app.library, self.app.settings
        today = date.today().isoformat()
        if self.state["day"] != today:
            self.state.update(day=today, uploaded=0)
        lib.skip_stale_clips(time.time() - 7 * 86400)
        changed = False
        room = s.sync_clips_per_day - self.state["uploaded"]
        for row in lib.unsynced_clips(max(0, room)):
            path = s.media / row["clip"]
            if not path.is_file():
                lib.mark_synced(row["clip"], 3)
                continue
            code = self._call("PUT", "/api/sync/clip?path=" + urllib.parse.quote(row["clip"]), path.read_bytes(),
                              {"Content-Type": "video/mp4"})
            if code != 200:
                raise RuntimeError(f"clip upload answered {code}")
            lib.mark_synced(row["clip"], 1)
            self.state["uploaded"] += 1
            changed = True
        # stay inside the budget: drop the oldest clips that aren't starred
        rows = lib.synced_clips_oldest_first()
        sizes = {r["clip"]: (s.media / r["clip"]).stat().st_size if (s.media / r["clip"]).is_file() else 0 for r in rows}
        total = sum(sizes.values())
        budget = s.sync_budget_mb * 1024 * 1024
        for r in rows:
            if total <= budget:
                break
            if r["starred"]:
                continue
            code = self._call("DELETE", "/api/sync/clip?path=" + urllib.parse.quote(r["clip"]))
            if code not in (200, 404):
                raise RuntimeError(f"clip delete answered {code}")
            lib.mark_synced(r["clip"], 2)
            total -= sizes[r["clip"]]
            changed = True
        stale = lib.changed_at > self.state["snapshotAt"]
        if changed or (stale and (self._snapshot_due or time.time() - self.state["snapshotAt"] > 600)):
            body = gzip.compress(json.dumps(lib.export(app.patterns(), cloud=True), separators=(",", ":")).encode())
            code = self._call("PUT", "/api/sync/library", body,
                              {"Content-Type": "application/json", "Content-Encoding": "gzip"})
            if code != 200:
                raise RuntimeError(f"library upload answered {code}")
            self.state["snapshotAt"] = time.time()
            self._snapshot_due = False
