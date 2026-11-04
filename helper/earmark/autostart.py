"""Start Earmark when you log in, so it's simply there whenever you watch (macOS: a LaunchAgent).

    earmark autostart on | off
"""

from __future__ import annotations

import os
import plistlib
import subprocess
import sys
from pathlib import Path

LABEL = "dev.kivz.earmark"
PLIST = Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"
LOG = Path.home() / "Library" / "Logs" / "earmark.log"


def is_on() -> bool:
    return sys.platform == "darwin" and PLIST.is_file()


def turn_on(helper_dir: Path) -> Path:
    if sys.platform != "darwin":
        raise RuntimeError("starting at login is set up for macOS only so far: add `uv run earmark` to your startup apps")
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    LOG.parent.mkdir(parents=True, exist_ok=True)
    PLIST.write_bytes(plistlib.dumps({
        "Label": LABEL,
        "ProgramArguments": [sys.executable, "-m", "earmark"],
        "WorkingDirectory": str(helper_dir),
        "EnvironmentVariables": {"PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"},
        "RunAtLoad": True,
        "KeepAlive": {"SuccessfulExit": False},  # back up after a crash, not after you stop it
        "StandardOutPath": str(LOG),
        "StandardErrorPath": str(LOG),
    }))
    domain = f"gui/{os.getuid()}"
    subprocess.run(["launchctl", "bootout", domain, str(PLIST)], capture_output=True)
    subprocess.run(["launchctl", "bootstrap", domain, str(PLIST)], check=True, capture_output=True)
    return PLIST


def turn_off() -> None:
    subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}", str(PLIST)], capture_output=True)
    PLIST.unlink(missing_ok=True)
