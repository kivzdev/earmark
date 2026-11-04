"""Settings and paths.

Values come from the environment, then from a `.env` file at the repository root
(never committed). Nothing secret is ever written into the repository.
"""

from __future__ import annotations

import json
import os
import secrets
import sys
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PORT = 3276  # E-A-R-M on a phone keypad


def data_home() -> Path:
    if os.environ.get("EARMARK_HOME"):
        return Path(os.environ["EARMARK_HOME"]).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Earmark"
    if os.name == "nt":
        return Path(os.environ.get("APPDATA", Path.home())) / "Earmark"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "earmark"


def load_env_file(path: Path) -> None:
    """KEY=VALUE lines, `#` comments, optional quotes. Variables already set win."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip().removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


@dataclass
class Settings:
    home: Path
    port: int
    # speech to text: parakeet (Apple Silicon), whisper (anything else) or cloud
    engine: str
    model: str
    # any OpenAI-compatible /audio/transcriptions endpoint; Groq is the cheap default
    cloud_url: str
    cloud_key: str
    cloud_model: str
    # optional mirror of the library (see /cloud in the repository)
    sync_url: str
    sync_token: str
    sync_uploads_per_day: int
    sync_budget_mb: int
    # Claude picks the good moments when there's a key; the phrase list does otherwise
    ai_key: str
    ai_model: str
    # the extension connects by itself (any Chrome extension on this computer may ask; see the README)
    auto_pair: bool
    # moments nobody kept lose their video after this many days (the transcript stays)
    keep_days: int

    @property
    def media(self) -> Path:
        return self.home / "media"

    @property
    def db_path(self) -> Path:
        return self.home / "earmark.db"


def default_engine() -> str:
    if sys.platform == "darwin" and os.uname().machine == "arm64":
        return "parakeet"
    return "whisper"


def load() -> Settings:
    load_env_file(REPO / ".env")
    engine = os.environ.get("EARMARK_ENGINE", "").strip() or default_engine()
    models = {
        "parakeet": "mlx-community/parakeet-tdt-0.6b-v2",
        "whisper": "small.en",
        "cloud": "",
    }
    home = data_home()
    home.mkdir(parents=True, exist_ok=True)
    return Settings(
        home=home,
        port=_int("EARMARK_PORT", PORT),
        engine=engine,
        model=os.environ.get("EARMARK_MODEL", "").strip() or models.get(engine, ""),
        cloud_url=os.environ.get("EARMARK_CLOUD_ASR_URL", "https://api.groq.com/openai/v1").rstrip("/"),
        cloud_key=os.environ.get("EARMARK_CLOUD_ASR_KEY", "") or os.environ.get("GROQ_API_KEY", ""),
        cloud_model=os.environ.get("EARMARK_CLOUD_ASR_MODEL", "whisper-large-v3-turbo"),
        sync_url=os.environ.get("EARMARK_SYNC_URL", "").rstrip("/"),
        sync_token=os.environ.get("EARMARK_SYNC_TOKEN", ""),
        sync_uploads_per_day=_int("EARMARK_SYNC_UPLOADS_PER_DAY", 50),
        sync_budget_mb=_int("EARMARK_SYNC_BUDGET_MB", 900),
        ai_key=os.environ.get("ANTHROPIC_API_KEY", "").strip() if os.environ.get("EARMARK_AI", "on") != "off" else "",
        ai_model=os.environ.get("EARMARK_AI_MODEL", "claude-haiku-5-5"),
        auto_pair=os.environ.get("EARMARK_AUTO_PAIR", "1") != "0",
        keep_days=_int("EARMARK_KEEP_DAYS", 7),
    )


def extension_token(home: Path) -> str:
    """The secret the browser extension sends with every request. Made once, kept private."""
    path = home / "secret.json"
    if path.is_file():
        try:
            token = json.loads(path.read_text())["token"]
            if isinstance(token, str) and len(token) >= 32:
                return token
        except (ValueError, KeyError):
            pass
    token = secrets.token_urlsafe(32)
    path.write_text(json.dumps({"token": token}))
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return token
