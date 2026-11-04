"""Draws Earmark's icon (a yellow bookmark ribbon, kivz.dev's mascot yellow) as PNGs for the extension and the site.

    helper/.venv/bin/python scripts/icons.py
"""

import struct
import zlib
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
YELLOW = (0xFD, 0xD9, 0x00)


def ribbon(size: int, ss: int = 8) -> np.ndarray:
    """Coverage of the ribbon on a size×size grid: a tall rounded-top tab with a notch cut into its foot."""
    n = size * ss
    y, x = np.mgrid[0:n, 0:n] / n + 0.5 / n
    x0, x1, y0, y1 = 0.22, 0.78, 0.08, 0.94
    r = 0.10  # top corners
    notch = 0.20  # how far the V reaches up
    inside = (x >= x0) & (x <= x1) & (y >= y0) & (y <= y1)
    for cx in (x0 + r, x1 - r):
        corner = (y < y0 + r) & (np.abs(x - cx) > 0) & (((x < x0 + r) & (cx == x0 + r)) | ((x > x1 - r) & (cx == x1 - r)))
        inside &= ~(corner & ((x - cx) ** 2 + (y - (y0 + r)) ** 2 > r**2))
    mid = (x0 + x1) / 2
    v = y1 - notch * (1 - np.abs(x - mid) / ((x1 - x0) / 2))
    inside &= y <= v
    return inside.reshape(size, ss, size, ss).mean(axis=(1, 3))


def png(path: Path, cover: np.ndarray) -> None:
    h, w = cover.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[..., :3] = YELLOW
    rgba[..., 3] = np.round(cover * 255).astype(np.uint8)
    raw = b"".join(b"\x00" + rgba[i].tobytes() for i in range(h))
    chunk = lambda tag, data: struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


if __name__ == "__main__":
    for size in (16, 32, 48, 128):
        png(ROOT / "extension" / "icons" / f"{size}.png", ribbon(size))
    png(ROOT / "public" / "icon-192.png", ribbon(192))
    png(ROOT / "public" / "favicon-32.png", ribbon(32))
    print("ok")
