"""ffmpeg plumbing.

The browser sends one continuous WebM stream per watched stream. A single ffmpeg
process turns it into 16 kHz mono PCM for speech recognition and into short H.264
segments on disk, so any moment from the last minute or two can be cut into a clip.
"""

from __future__ import annotations

import csv
import re
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from typing import Callable

SEGMENT = 2.0  # seconds per buffered segment
LOW = 360  # the light copy's height


def ffmpeg() -> str:
    path = shutil.which("ffmpeg") or ("/opt/homebrew/bin/ffmpeg" if Path("/opt/homebrew/bin/ffmpeg").exists() else None)
    if not path:
        raise RuntimeError("ffmpeg is not installed (macOS: brew install ffmpeg)")
    return path


def _has_encoder(name: str) -> bool:
    try:
        out = subprocess.run([ffmpeg(), "-hide_banner", "-encoders"], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return False
    return f" {name} " in out


_HARDWARE: bool | None = None
_X264: bool | None = None


def video_encoder(bitrate: str) -> list[str]:
    """The live stream's H.264: the Mac's hardware encoder, which keeps up with it for next to nothing; x264 elsewhere."""
    global _HARDWARE
    if _HARDWARE is None:
        _HARDWARE = sys.platform == "darwin" and _has_encoder("h264_videotoolbox")
    if _HARDWARE:
        codec = ["-c:v", "h264_videotoolbox", "-realtime", "1", "-allow_sw", "1", "-profile:v", "main"]
    else:
        codec = ["-c:v", "libx264", "-preset", "veryfast", "-profile:v", "main"]
    return [*codec, "-b:v", bitrate, "-maxrate", bitrate, "-bufsize", bitrate, "-pix_fmt", "yuv420p"]


def clip_encoder(crf: int, cap: int) -> list[str]:
    """A clip's H.264 (kept and watched): x264 at constant quality, up to `cap` kb/s. Next to the hardware encoder it
    looks clearly better at the same size and keeps to it (the hardware one overshot 1 Mb/s by three quarters on a
    busy game, at a worse picture); a quiet scene comes out smaller. 720p runs at about 16x real time on an M4."""
    global _X264
    if _X264 is None:
        _X264 = _has_encoder("libx264")
    if not _X264:
        return video_encoder(f"{cap}k")
    return ["-c:v", "libx264", "-preset", "faster", "-profile:v", "high", "-crf", str(crf),
            "-maxrate", f"{cap}k", "-bufsize", f"{cap * 2}k", "-pix_fmt", "yuv420p"]


class Recorder:
    """One ffmpeg process per watched stream: WebM in, PCM out, H.264 segments to disk."""

    def __init__(self, workdir: Path, on_pcm: Callable[[bytes], None], on_exit: Callable[[str], None]):
        self.dir = workdir
        workdir.mkdir(parents=True, exist_ok=True)
        self._on_pcm = on_pcm
        self._on_exit = on_exit
        self._lock = threading.Lock()
        self.list_path = workdir / "segments.csv"
        cmd = [
            ffmpeg(), "-hide_banner", "-loglevel", "error", "-nostdin",
            "-fflags", "+genpts+discardcorrupt", "-i", "pipe:0",
            # speech: mono 16 kHz, silence-padded so sample n is always at n / 16000 s
            "-map", "0:a:0", "-af", "aresample=16000:async=1:first_pts=0", "-ac", "1", "-f", "s16le", "pipe:1",
            # clips: up-to-720p segments, a keyframe every second so cuts stay cheap
            "-map", "0:v:0?", "-map", "0:a:0", "-vf", "scale=-2:'min(720,ih)',fps=30",
            *video_encoder("2500k"), "-g", "30", "-force_key_frames", "expr:gte(t,n_forced*1)",
            "-c:a", "aac", "-b:a", "128k", "-ar", "48000",
            "-f", "segment", "-segment_time", str(SEGMENT), "-segment_format", "mpegts",
            "-segment_list", str(self.list_path), "-segment_list_type", "csv", "-reset_timestamps", "0",
            str(workdir / "seg_%06d.ts"),
        ]
        self._proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self._reader = threading.Thread(target=self._read, name=f"pcm-{workdir.name}", daemon=True)
        self._reader.start()

    def _read(self) -> None:
        out = self._proc.stdout
        while True:
            data = out.read(16_000)  # half a second
            if not data:
                break
            self._on_pcm(data)
        self._proc.wait()
        err = self._proc.stderr.read().decode(errors="replace").strip() if self._proc.stderr else ""
        self._on_exit(err[-600:])

    @property
    def alive(self) -> bool:
        return self._proc.poll() is None

    def feed(self, data: bytes) -> None:
        with self._lock:
            if self._proc.stdin and self.alive:
                self._proc.stdin.write(data)
                self._proc.stdin.flush()

    def close(self) -> None:
        with self._lock:
            if self._proc.stdin and not self._proc.stdin.closed:
                try:
                    self._proc.stdin.close()
                except OSError:
                    pass

    def wait(self, timeout: float = 20) -> None:
        self._reader.join(timeout)
        if self.alive:
            self._proc.kill()

    def segments(self) -> list[tuple[Path, float, float]]:
        """Finished segments as (file, start, end), in stream seconds."""
        if not self.list_path.exists():
            return []
        rows = []
        with self.list_path.open(newline="") as f:
            for row in csv.reader(f):
                if len(row) >= 3:
                    try:
                        rows.append((self.dir / row[0], float(row[1]), float(row[2])))
                    except ValueError:
                        pass
        return rows

    def forget_before(self, t: float) -> None:
        """Delete segments that end before stream time `t`."""
        for path, _, end in self.segments():
            if end < t:
                path.unlink(missing_ok=True)


def cut(
    segments: list[tuple[Path, float, float]],
    t0: float,
    t1: float,
    out: Path,
    poster: Path | None,
    poster_at: float,
    thumb: Path | None = None,
) -> bool:
    """Cut [t0, t1] (stream seconds) out of the buffered segments into an MP4 (720p, clear mono speech, 4–12 MB a
    minute as busy as the picture is), with a full-size poster frame and a 480 px thumbnail."""
    parts = [(p, s, e) for p, s, e in segments if e > t0 and s < t1 and p.exists()]
    if not parts:
        return False
    out.parent.mkdir(parents=True, exist_ok=True)
    listing = out.with_suffix(".txt")
    listing.write_text("".join(f"file '{p.as_posix()}'\n" for p, _, _ in parts))
    start = max(0.0, t0 - parts[0][1])
    tmp = out.with_suffix(".part.mp4")
    cmd = [
        ffmpeg(), "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "concat", "-safe", "0", "-i", str(listing),
        "-ss", f"{start:.3f}", "-t", f"{t1 - t0:.3f}",
        "-map", "0:v:0?", "-map", "0:a:0", *clip_encoder(23, 1500), "-g", "60",
        "-c:a", "aac", "-b:a", "96k", "-ac", "1", "-movflags", "+faststart", str(tmp),
    ]
    try:
        done = subprocess.run(cmd, capture_output=True, timeout=60)
    finally:
        listing.unlink(missing_ok=True)
    if done.returncode != 0 or not tmp.exists() or tmp.stat().st_size < 1000:
        tmp.unlink(missing_ok=True)
        return False
    tmp.replace(out)
    for path, size, quality in ((poster, None, "4"), (thumb, "480:-2", "4")):
        if path is None:
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [ffmpeg(), "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
             "-ss", f"{max(0.0, poster_at - t0):.3f}", "-i", str(out), "-frames:v", "1",
             *(["-vf", f"scale={size}"] if size else []), "-q:v", quality, str(path)],
            capture_output=True, timeout=30,
        )
    return True


def low_copy(clip: Path, out: Path) -> bool:
    """The clip again at 360p (2–4 MB a minute): the player's light choice, for slow connections, and what the
    online copy keeps of older moments when its space runs short."""
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name.replace(".mp4", ".part.mp4"))
    done = subprocess.run(
        [ffmpeg(), "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", str(clip),
         "-vf", f"scale=-2:{LOW}", *clip_encoder(26, 500), "-g", "60",
         "-c:a", "aac", "-b:a", "64k", "-ac", "1", "-movflags", "+faststart", str(tmp)],
        capture_output=True, timeout=120,
    )
    if done.returncode != 0 or not tmp.exists() or tmp.stat().st_size < 1000:
        tmp.unlink(missing_ok=True)
        return False
    tmp.replace(out)
    return True


def video_height(path: Path) -> int | None:
    """how tall a video's picture is, from ffmpeg's description of the file"""
    try:
        done = subprocess.run([ffmpeg(), "-hide_banner", "-nostdin", "-i", str(path)],
                              capture_output=True, text=True, timeout=20)
    except Exception:
        return None
    m = re.search(r"Video: .*?, (\d{2,5})x(\d{2,5})[ ,]", done.stderr)
    return int(m.group(2)) if m else None
