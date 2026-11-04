# Earmark

Earmark watches Twitch with you and keeps the everyday English you hear. It writes down everything the streamer says,
cuts the stream into one-minute moments with their video, keeps the ones worth hearing again — *I have to go down
without dying*, *it's just blown up*, *we'll figure it out* — and points out the expressions in them, so you can replay
a sentence until the fast, mumbled version makes sense.

It runs on your own computer. Nothing is sent anywhere unless you add an Anthropic key (to let Claude pick the moments)
or set up a private copy of your own.

```
Chrome extension ──► the Earmark helper on your computer ──► your dashboard (http://127.0.0.1:3276)
 (twitch.tv tab)      speech to text · moments · clips          └─► optional private copy online
```

## What it does

- **Listens with you.** While a Twitch stream or VOD plays, the extension hands a small 360p copy of what the player
  shows and says to the helper. It pauses during ads and skips streams tagged with another language.
- **Writes down everything said**, on your computer: NVIDIA's Parakeet on Apple Silicon, Whisper elsewhere.
- **Cuts it into moments**: about a minute each, at sentence ends, with the video and the transcript word by word.
  In the player the words light up as they're spoken; click a sentence to hear it again and again; slow it to
  0.75× or 0.5× for the quick, swallowed bits.
- **Keeps the good ones for you.** With an Anthropic API key, Claude Haiku 5.5 reads each minute and scores how much
  everyday spoken English is in it, gives it a title and picks out the expressions worth learning, with a short note
  each. Without a key, a built-in list of 110+ everyday phrases does the same job by rules.
- **A catalog like Twitch's**: your categories with Twitch's covers, the channels you watch (live now, when they last
  streamed, their last stream), and who's live in a category right now. Streams are sorted into politics,
  entertainment and gaming (with the game) from their own Twitch category, title and tags; you can correct any
  channel.
- **Expressions, across voices**: every expression links to each moment it was said in, by whoever said it.

## What it costs

Speech recognition runs on your computer for free, and clips are just files. Letting Claude pick the moments costs
about a cent or two per hour of stream (Claude Haiku 5.5, a short request per minute); without a key it's free. If
your computer is too slow for local speech recognition, Groq's `whisper-large-v3-turbo` does it for about $0.04 an hour.

## Setup

You need Chrome 116 or later, [ffmpeg](https://ffmpeg.org), [uv](https://docs.astral.sh/uv/) (it brings Python) and
Node.js 20 or later.

**macOS (Apple Silicon)**

```bash
brew install ffmpeg uv node
git clone https://github.com/kivzdev/earmark && cd earmark
npm install && npm run build            # the dashboard
cd helper && uv sync --extra mlx        # the helper, with Parakeet on MLX
uv run earmark                          # first start downloads the speech model (about 2.5 GB)
```

**Windows / Linux / Intel Macs**: install ffmpeg, uv and Node.js, then `uv sync --extra whisper` instead. Earmark uses
Whisper (`small.en` by default; set `EARMARK_MODEL` for another size) through faster-whisper.

**The extension**: open `chrome://extensions`, turn on *Developer mode*, choose *Load unpacked* and pick the
`extension` folder. Click Earmark in the toolbar, then *Connect to Earmark*, and allow it in the dashboard tab that
opens. That's it: open an English stream on Twitch.

The extension connects to the helper by itself. To have the helper start whenever you log in (macOS):

```bash
uv run earmark autostart on
```

Otherwise keep it running while you watch (`uv run earmark` in `helper/`, or `npm run helper` from the top folder).

**Let Claude pick the moments** (optional): put `ANTHROPIC_API_KEY=…` in `.env` at the top folder and restart the
helper (`uv run earmark autostart on` restarts it too).

### Without Twitch

Any video or audio file goes through the same steps:

```bash
uv run earmark listen talk.mp4 --channel me --category "Just Chatting"
uv run earmark doctor        # checks ffmpeg and the speech engine
```

### Your own phrases

Without Claude, moments are picked by the phrase list. In *Settings*, add a phrase in plain words, with `…` where
anything can go: `end up …ing`.

## Privacy and security

- The extension only reads twitch.tv pages and only talks to `127.0.0.1`. It has no other permissions. It connects to
  the helper by itself; any extension on your computer could ask the same way, so set `EARMARK_AUTO_PAIR=0` if you'd
  rather allow it on the dashboard.
- The helper only listens on `127.0.0.1`. It answers only requests addressed to that name (so a web page can't reach it
  through DNS rebinding), the extension's requests carry a secret token you approve once in the dashboard, and the
  dashboard's changes need a header that other sites can't send.
- Your library lives in `~/Library/Application Support/Earmark` (macOS), `%APPDATA%\Earmark` (Windows) or
  `~/.local/share/earmark` (Linux).
- Secrets go in `.env` (see `.env.example`), which is never committed.
- With an Anthropic key, each minute's transcript (text only, never video or audio) goes to Anthropic's API.
- For covers, pictures and live status, the helper asks Twitch's public web API about the channels and categories you
  watched, the same questions twitch.tv's own pages ask; nothing about you is sent.
- Clips are for your own study. Don't republish other people's streams.

## A private copy online (optional)

The same dashboard can run on [Vercel](https://vercel.com), so you can look at your library from your phone. It holds
only what your helper uploads and opens only with your passkey (Face ID, Touch ID or a security key).

1. Deploy this repository to Vercel, connect a **private** Vercel Blob store to the project, and set
   `EARMARK_ORIGIN` (its address), `SESSION_SECRET` (32+ random characters), `EARMARK_SETUP_CODE` and
   `EARMARK_SYNC_TOKEN` in the project's environment variables.
2. On your computer, put the address and the same token in `.env` as `EARMARK_SYNC_URL` and `EARMARK_SYNC_TOKEN`, and
   restart the helper.
3. Open the site, type the setup code, and make a passkey. The code only works while the site has no passkey; if you
   ever lose them all, delete `auth/passkeys.json` from the Blob store and set up again.

Only the kept moments go up. Vercel's free plan gives Blob storage 1 GB and 2,000 uploads a month, so the helper uploads
at most 25 clips a day (starred and newest first) and keeps the copy under 900 MB by removing the oldest clips that
aren't starred; their small pictures ride along inside the library. Your computer keeps every moment, and the video of
moments nobody kept for 14 days (`EARMARK_KEEP_DAYS`). Limits are in `.env.example`.

## Development

```bash
npm run dev                  # the dashboard with hot reload on :5191, against the helper on :3276
npx tsx server/dev.ts        # the online copy's API, with files in a folder (EARMARK_CLOUD_DIR) instead of Blob
```

- `extension/`: the Chrome extension (no build step)
- `helper/`: the helper, in Python: speech engines, phrase matching, clip cutting, the local server, the cloud sync
- `src/`: the dashboard (React, Vite, GSAP), the same for the helper and the online copy
- `server/`, `api/`: the online copy's API (Hono on Vercel)

## Credits

Speech recognition by [Parakeet TDT 0.6B v2](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2) (NVIDIA, CC-BY-4.0)
through [parakeet-mlx](https://github.com/senstella/parakeet-mlx), and by
[faster-whisper](https://github.com/SYSTRAN/faster-whisper). Icons by [Phosphor](https://phosphoricons.com). The
design follows [kivz.dev](https://kivz.dev).

MIT license.
