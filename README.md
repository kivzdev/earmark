# Earmark

Earmark watches Twitch with you and keeps the everyday English you hear — *which is…*, *the thing is…*, *I was gonna…*,
*to be fair…* — together with the clip it was said in. Every phrase becomes a card, and every streamer who says it adds
their own clip to it, so you can hear the same phrase again and again, in different voices.

It runs on your own computer. Nothing is sent anywhere unless you set up a private copy of your own.

```
Chrome extension ──► the Earmark helper on your computer ──► your dashboard (http://127.0.0.1:3276)
 (twitch.tv tab)      speech to text · phrases · clips          └─► optional private copy online
```

## What it does

- **Listens with you.** While a Twitch stream or VOD plays, the extension hands a small 360p copy of what the player
  shows and says to the helper. It pauses during ads and skips streams tagged with another language.
- **Writes down what's said**, on your computer: NVIDIA's Parakeet on Apple Silicon, Whisper elsewhere.
- **Catches everyday phrases**: 110+ connectors, sentence frames, discourse markers, phrasal verbs and set expressions
  (`helper/earmark/patterns.json`), plus any you add. Sentences don't have to match exactly; the phrase does.
- **Clips the moment**: the sentence, cut to its own edges, with the words lighting up as they're spoken. Loop it,
  or jump to *another voice* saying the same phrase.
- **Sorts what you watch** into politics, entertainment and gaming (with the game: Minecraft, Call of Duty,
  Counter-Strike…), from the stream's own Twitch category, title and tags. You can correct any streamer.
- **Shows your day**: how long you watched, how many words you heard, what you caught, and the days before.

## What it costs

Nothing, by default. Speech recognition runs on your computer and phrases are matched by rules, so no AI tokens are
used at all; clips are just files. If your computer is too slow for local speech recognition, you can use a cheap
cloud engine instead: Groq's `whisper-large-v3-turbo` costs about $0.04 per hour of audio.

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

Keep the helper running while you watch (`uv run earmark` in `helper/`, or `npm run helper` from the top folder).

### Without Twitch

Any video or audio file goes through the same steps:

```bash
uv run earmark listen talk.mp4 --channel me --category "Just Chatting"
uv run earmark doctor        # checks ffmpeg and the speech engine
```

### Your own phrases

In *Settings*, add a phrase in plain words, with `…` where anything can go: `end up …ing`. Earmark listens for it
from then on.

## Privacy and security

- The extension only reads twitch.tv pages and only talks to `127.0.0.1`. It has no other permissions.
- The helper only listens on `127.0.0.1`. It answers only requests addressed to that name (so a web page can't reach it
  through DNS rebinding), the extension's requests carry a secret token you approve once in the dashboard, and the
  dashboard's changes need a header that other sites can't send.
- Your library lives in `~/Library/Application Support/Earmark` (macOS), `%APPDATA%\Earmark` (Windows) or
  `~/.local/share/earmark` (Linux).
- Secrets go in `.env` (see `.env.example`), which is never committed.
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

Vercel's free plan gives Blob storage 1 GB and 2,000 uploads a month, so the helper uploads at most 40 clips a day
(starred and newest first) and keeps the copy under 900 MB by removing the oldest clips that aren't starred. Your
computer always keeps everything. Both limits are in `.env.example`.

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
