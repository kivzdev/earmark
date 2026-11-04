"""Speech to text. Every engine turns 16 kHz mono float audio into words with times.

A word is `(text, start, end)`: text keeps its punctuation ("crazy," "right?"),
times are seconds from the start of the audio it was given.
"""

from __future__ import annotations

import io
import json
import queue
import threading
import urllib.error
from concurrent.futures import Future
import urllib.request
import uuid
import wave

import numpy as np

RATE = 16_000
Word = tuple[str, float, float]


def _clean(text: str) -> str:
    return text.replace("’", "'").replace("‘", "'").strip()


class Parakeet:
    """NVIDIA Parakeet TDT on Apple's MLX. Apple Silicon only."""

    name = "parakeet"

    def __init__(self, model_id: str):
        import mlx.core as mx
        from parakeet_mlx import from_pretrained
        from parakeet_mlx.audio import get_logmel

        self._mx = mx
        # get_logmel is wrapped in an unbounded lru_cache that would keep every
        # window of a long stream alive; call the function underneath
        self._logmel = getattr(get_logmel, "__wrapped__", get_logmel)
        self._model = from_pretrained(model_id)

    def transcribe(self, audio: np.ndarray) -> list[Word]:
        mx = self._mx
        # the mel code views the STFT as pairs of the input dtype: it must be float32
        x = mx.array(np.ascontiguousarray(audio, dtype=np.float32))
        mel = self._logmel(x, self._model.preprocessor_config)
        result = self._model.generate(mel)[0]
        # tokens are word pieces; a piece that starts with a space starts a new word
        words: list[list] = []
        for token in result.tokens:
            text = token.text
            if not text:
                continue
            if not words or text.startswith(" "):
                words.append([text, token.start, token.end])
            else:
                words[-1][0] += text
                words[-1][2] = token.end
        return [(_clean(t), float(s), float(e)) for t, s, e in words if _clean(t)]


class Whisper:
    """Whisper through faster-whisper (CTranslate2). Runs on Windows, Linux and Intel Macs."""

    name = "whisper"

    def __init__(self, model_id: str):
        from faster_whisper import WhisperModel

        self._model = WhisperModel(model_id, device="auto", compute_type="int8")

    def transcribe(self, audio: np.ndarray) -> list[Word]:
        segments, _ = self._model.transcribe(
            np.ascontiguousarray(audio, dtype=np.float32),
            language="en",
            word_timestamps=True,
            vad_filter=True,
            condition_on_previous_text=False,
            beam_size=1,
        )
        words: list[Word] = []
        for segment in segments:
            for w in segment.words or []:
                text = _clean(w.word)
                if text:
                    words.append((text, float(w.start), float(w.end)))
        return words


def wav_bytes(audio: np.ndarray, rate: int = RATE) -> bytes:
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return out.getvalue()


class Cloud:
    """Any OpenAI-compatible transcription API. With Groq's whisper-large-v3-turbo
    an hour of audio costs about four cents (Groq bills at least 10 s per request)."""

    name = "cloud"

    def __init__(self, url: str, key: str, model: str):
        if not key:
            raise RuntimeError("EARMARK_CLOUD_ASR_KEY (or GROQ_API_KEY) is not set")
        self._url = url + "/audio/transcriptions"
        self._key = key
        self._model = model

    def transcribe(self, audio: np.ndarray) -> list[Word]:
        boundary = uuid.uuid4().hex
        fields = {
            "model": self._model,
            "language": "en",
            "temperature": "0",
            "response_format": "verbose_json",
            "timestamp_granularities[]": "word",
        }
        body = io.BytesIO()
        for k, v in fields.items():
            body.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
        body.write(
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\n'
            "Content-Type: audio/wav\r\n\r\n".encode()
        )
        body.write(wav_bytes(audio))
        body.write(f"\r\n--{boundary}--\r\n".encode())
        request = urllib.request.Request(
            self._url,
            data=body.getvalue(),
            headers={
                "Authorization": f"Bearer {self._key}",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "User-Agent": "earmark",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                data = json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"transcription API answered {error.code}: {error.read()[:200]!r}") from None
        return _punctuate(data.get("words") or [], data.get("segments") or [])


def _punctuate(words: list[dict], segments: list[dict]) -> list[Word]:
    """Whisper APIs give words without punctuation and segments with it: put it back."""
    out: list[Word] = []
    pending = [(_clean(w.get("word", "")), float(w["start"]), float(w["end"])) for w in words]
    pending = [w for w in pending if w[0]]
    i = 0
    for segment in segments or [{"start": 0, "end": 1e9, "text": ""}]:
        group = []
        while i < len(pending) and pending[i][1] < float(segment["end"]) - 0.01:
            group.append(pending[i])
            i += 1
        tokens = _clean(segment.get("text", "")).split()
        if tokens and len(tokens) == len(group):
            group = [(tok, s, e) for tok, (_, s, e) in zip(tokens, group)]
        elif group and tokens and tokens[-1][-1:] in ".?!" and group[-1][0][-1:] not in ".?!":
            text, s, e = group[-1]
            group[-1] = (text + tokens[-1][-1], s, e)
        out.extend(group)
    out.extend(pending[i:])
    return out


class Engine:
    """Loads the chosen engine once and runs every transcription on that same thread
    (MLX streams belong to the thread that made them), one request at a time."""

    def __init__(self, settings):
        self.settings = settings
        self.name = settings.engine
        self.error: str | None = None
        self._impl = None
        self._ready = threading.Event()
        self._jobs: queue.Queue = queue.Queue()
        threading.Thread(target=self._work, name="engine", daemon=True).start()

    def _load(self) -> None:
        s = self.settings
        try:
            if s.engine == "parakeet":
                self._impl = Parakeet(s.model)
            elif s.engine == "whisper":
                self._impl = Whisper(s.model)
            elif s.engine == "cloud":
                self._impl = Cloud(s.cloud_url, s.cloud_key, s.cloud_model)
            else:
                raise RuntimeError(f"unknown engine {s.engine!r} (parakeet, whisper or cloud)")
            # the first call compiles kernels; do it before real audio arrives
            if s.engine != "cloud":
                self._impl.transcribe(np.zeros(RATE, dtype=np.float32))
        except Exception as error:  # shown in the dashboard and the extension popup
            self._impl = None
            self.error = f"{type(error).__name__}: {error}"
        finally:
            self._ready.set()

    def _work(self) -> None:
        self._load()
        while True:
            audio, done = self._jobs.get()
            try:
                done.set_result(self._impl.transcribe(audio))
            except Exception as error:
                done.set_exception(error)

    @property
    def ready(self) -> bool:
        return self._ready.is_set() and self._impl is not None

    def wait(self, timeout: float | None = None) -> bool:
        return self._ready.wait(timeout)

    def transcribe(self, audio: np.ndarray) -> list[Word]:
        self._ready.wait()
        if self._impl is None:
            raise RuntimeError(self.error or "speech engine failed to load")
        done: Future = Future()
        self._jobs.put((audio, done))
        return done.result()
