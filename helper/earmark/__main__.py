"""earmark — run the helper, or check the setup.

  earmark                 start (dashboard at http://127.0.0.1:3276)
  earmark doctor          check ffmpeg, the speech engine and where data is kept
  earmark listen FILE     run a video or audio file through Earmark as if you watched it
                          [--channel NAME] [--category "Just Chatting"] [--title TEXT]
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time

from . import __version__
from .config import load


def _serve() -> None:
    from .app import App
    from .server import serve

    settings = load()
    app = App(settings)
    url = f"http://127.0.0.1:{settings.port}"
    print(f"Earmark {__version__} · {url}")
    print(f"  speech: {settings.engine} ({settings.model or settings.cloud_model}) — loading…")
    print(f"  data:   {settings.home}")
    if app.sync:
        print(f"  cloud:  {settings.sync_url}")
    try:
        serve(app)
    except OSError as error:
        sys.exit(f"Can't listen on {url}: {error}")
    except KeyboardInterrupt:
        print("\nbye")


def _doctor() -> int:
    from .asr import Engine
    from .media import ffmpeg

    settings = load()
    ok = True
    try:
        print("ffmpeg ", ffmpeg())
    except RuntimeError as error:
        print("ffmpeg  MISSING —", error)
        ok = False
    print("data   ", settings.home)
    print("engine ", settings.engine, settings.model or settings.cloud_model)
    engine = Engine(settings)
    t = time.time()
    while not engine.wait(1):
        print("        loading…", round(time.time() - t), "s")
    if engine.error:
        print("        FAILED —", engine.error)
        ok = False
    else:
        print("        ready")
    return 0 if ok else 1


def _listen(args) -> int:
    from .app import App
    from .media import ffmpeg

    settings = load()
    app = App(settings)
    while not app.engine.wait(1):
        pass
    if app.engine.error:
        print(app.engine.error)
        return 1
    session = app.start_session({
        "channel": args.channel, "displayName": args.channel, "category": args.category, "title": args.title,
    })
    # the extension sends WebM; make the file look the same
    enc = subprocess.Popen(
        [ffmpeg(), "-hide_banner", "-loglevel", "error", "-nostdin", "-i", args.file,
         "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "1M", "-vf", "scale=-2:360",
         "-c:a", "libopus", "-b:a", "96k", "-f", "webm", "pipe:1"],
        stdout=subprocess.PIPE,
    )
    seq = 0
    while True:
        chunk = enc.stdout.read(256 * 1024)
        if not chunk:
            break
        seq += 1
        session.feed(seq, chunk)
    enc.wait()
    session.end()
    while app.session(session.id):
        time.sleep(0.5)
    print(f"heard {session.pcm.end:.0f} s · {session.words} words · caught {session.caught}")
    if session.error:
        print("error:", session.error)
    for c in reversed(session.recent):
        print(f"  {c['pattern']:<28} {c['sentence']}")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(prog="earmark", description="Watches Twitch with you and keeps the everyday English you hear.")
    sub = parser.add_subparsers(dest="cmd")
    sub.add_parser("serve")
    sub.add_parser("doctor")
    listen = sub.add_parser("listen")
    listen.add_argument("file")
    listen.add_argument("--channel", default="local")
    listen.add_argument("--category", default="Just Chatting")
    listen.add_argument("--title", default="")
    args = parser.parse_args()
    if args.cmd == "doctor":
        sys.exit(_doctor())
    if args.cmd == "listen":
        sys.exit(_listen(args))
    _serve()


if __name__ == "__main__":
    main()
