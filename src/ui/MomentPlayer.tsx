import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { media, store, thumbOf, write, type Seen } from '@/data'
import { Choices, Seek, Volume, mmss, sentenceAt } from './PlayerControls'
import {
  CaptionsIcon, FullIcon, LoopIcon, OutIcon, PauseIcon, PipIcon, PlayIcon, ReplayIcon, SettingsIcon, SmallIcon, StarIcon,
} from './icons'

const RATES = [1.5, 1.25, 1, 0.75, 0.5]
type Quality = 'auto' | 'hd' | 'low'
type Source = { key: 'hd' | 'low'; h: number; src: string }

/** for each word of a sentence: where it sits in the text, and whether an expression covers it */
function marks(text: string, words: string[], spans: [number, number][]) {
  let at = 0
  return words.map(w => {
    const start = text.indexOf(w, at)
    const s = start >= 0 ? start : at
    at = s + w.length
    return spans.some(([a, b]) => s < b && s + w.length > a)
  })
}

// the player's settings, kept in this browser (a private window starts over)
const pref = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(`earmark.${key}`)
    return v === null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}
const keep = (key: string, value: unknown) => {
  try { localStorage.setItem(`earmark.${key}`, JSON.stringify(value)) } catch { /* not kept */ }
}

/** a connection that asks for less: data saver on, or a slow mobile one (Chrome says; Safari doesn't) */
const sparing = () => {
  const c = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection
  return !!c && (c.saveData === true || ['slow-2g', '2g', '3g'].includes(c.effectiveType ?? ''))
}

/**
 * A moment on a plate: the clip with its own controls over its foot (the progress bar cut at each sentence, volume,
 * speed, captions, quality, picture in picture, full screen), its transcript lighting up word by word as it's said,
 * the expressions in it underlined. Click a sentence to hear it again and again (click it once more to go on).
 * Keys: space or K plays and pauses; ← → move a sentence; J L five seconds; M mutes; C captions; F full screen;
 * < > speed; 0–9 jump through the clip.
 */
export function MomentPlayer({ m, start, side }: { m: Seen; start?: number; side?: ReactNode }) {
  const shell = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const still = useRef<HTMLCanvasElement>(null)
  const [t, setT] = useState(-1)
  const [duration, setDuration] = useState(m.duration)
  const [buffered, setBuffered] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [ended, setEnded] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [rate, setRate] = useState(1)
  const [repeat, setRepeat] = useState<number | null>(null)
  const [volume, setVolume] = useState(() => pref('volume', 1))
  const [muted, setMuted] = useState(() => pref('muted', false))
  const [captions, setCaptions] = useState(() => pref('captions', false))
  const [quality, setQuality] = useState<Quality>(() => pref('quality', 'auto'))
  const [slow, setSlow] = useState(sparing)
  const [full, setFull] = useState(false)
  const [idle, setIdle] = useState(false)
  const [menu, setMenu] = useState<'speed' | 'quality' | null>(null)
  const [scrubbing, setScrubbing] = useState(false)
  const [flash, setFlash] = useState<{ n: number; play: boolean } | null>(null)
  const [retry, setRetry] = useState(0)
  const local = store().meta?.mode === 'local'

  // the clip's sizes, and the one playing: the chosen one, or (Auto) 720p unless the connection is slow
  const sources = useMemo(() => [
    m.clip ? { key: 'hd', h: m.clipH ?? 720, src: media(m.clip) } : null,
    m.low ? { key: 'low', h: 360, src: media(m.low) } : null,
  ].filter((s): s is Source => !!s), [m.clip, m.low, m.clipH])
  const low = sources.find(s => s.key === 'low')
  const source = (quality !== 'auto' && sources.find(s => s.key === quality)) || (slow && low) || sources[0]

  const current = t < 0 ? -1 : sentenceAt(m.sentences, t)
  const repeating = repeat !== null ? m.sentences[repeat] : null

  // the online copy has no full-size poster: there the clip shows its own frame at the thumbnail's moment (the
  // thumbnail stands in until it's loaded), and starts from the top when played
  const cover = useRef(false)

  // a new size (or a reload after an error) picks up where the other left off: its last frame waits on a canvas
  // until the new one is there, so nothing goes black
  const swap = useRef<{ t: number; play: boolean } | null>(null)
  const hold = () => {
    const v = video.current
    const c = still.current
    if (!v) return
    swap.current = { t: v.currentTime, play: !v.paused && !v.ended }
    if (!c || v.readyState < 2) return
    try {
      c.width = v.videoWidth
      c.height = v.videoHeight
      c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height)
      c.dataset.on = ''
    } catch { /* (nothing to draw from) */ }
  }
  const resumed = () => {
    const v = video.current
    const was = swap.current
    if (!v || !was) return
    swap.current = null
    if (was.play) v.play().catch(() => {})
    requestAnimationFrame(() => { if (still.current) delete still.current.dataset.on })
  }
  const choose = (q: Quality) => {
    setQuality(q)
    keep('quality', q)
    const next = (q !== 'auto' && sources.find(s => s.key === q)) || (slow && low) || sources[0]
    if (next && next.src !== source?.src) hold()
  }

  // follow the clip frame by frame while it plays; a repeated sentence goes back to its start when it's done
  useEffect(() => {
    if (!playing) return
    let id = 0
    const step = () => {
      const v = video.current
      if (v && !swap.current) {
        if (repeating && v.currentTime > repeating.t1 + 0.25) v.currentTime = Math.max(0, repeating.t0 - 0.15)
        setT(v.currentTime)
      }
      id = requestAnimationFrame(step)
    }
    id = requestAnimationFrame(step)
    return () => cancelAnimationFrame(id)
  }, [playing, repeating])

  useEffect(() => {
    const v = video.current
    if (v) { v.defaultPlaybackRate = rate; v.playbackRate = rate }
  }, [rate])
  useEffect(() => {
    const v = video.current
    if (v) { v.volume = volume; v.muted = muted }
  }, [volume, muted])

  // opened at a sentence (from an expression): start there
  useEffect(() => {
    const v = video.current
    if (start === undefined || !v || !m.sentences[start]) return
    const go = () => { v.currentTime = Math.max(0, m.sentences[start].t0 - 0.15); setT(v.currentTime) }
    if (v.readyState >= 1) go()
    else v.addEventListener('loadedmetadata', go, { once: true })
  }, [start, m.id])

  // the controls step aside while it plays and the pointer rests; they stay while paused, a list is open or the
  // focus is among them
  const timer = useRef(0)
  const wake = useCallback((after = 2600) => {
    setIdle(false)
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setIdle(true), after)
  }, [])
  useEffect(() => () => clearTimeout(timer.current), [])
  const resting = idle && playing && !menu && !scrubbing

  const toggle = (show = false) => {
    const v = video.current
    if (!v) return
    const play = v.paused || v.ended
    if (play) v.play().catch(() => {})
    else v.pause()
    if (show) setFlash(f => ({ n: (f?.n ?? 0) + 1, play }))
  }
  const seekTo = (time: number) => {
    const v = video.current
    if (!v) return
    cover.current = false
    const d = v.duration || duration
    v.currentTime = Math.max(0, Math.min(d - 0.05, time))
    setT(v.currentTime)
    setEnded(false)
    // (jumping out of a repeated sentence lets it go)
    if (repeating && (time < repeating.t0 - 0.4 || time > repeating.t1 + 0.4)) setRepeat(null)
  }
  const scrub = useRef(false)
  const onScrub = (on: boolean) => {
    const v = video.current
    if (!v) return
    setScrubbing(on)
    if (on) { scrub.current = !v.paused; v.pause() }
    else if (scrub.current) v.play().catch(() => {})
  }
  const say = (i: number) => {
    const v = video.current
    if (!v || !m.sentences[i]) return
    cover.current = false
    if (repeat === i) { setRepeat(null); return }
    setRepeat(i)
    v.currentTime = Math.max(0, m.sentences[i].t0 - 0.15)
    setT(v.currentTime)
    v.play().catch(() => {})
  }
  const step = (d: number) => {
    const v = video.current
    if (!v || !m.sentences.length) return
    cover.current = false
    const i = Math.max(0, Math.min(m.sentences.length - 1, (current < 0 ? 0 : current) + d))
    v.currentTime = Math.max(0, m.sentences[i].t0 - 0.15)
    setT(v.currentTime)
    if (repeat !== null) setRepeat(i)
  }
  const setVol = useCallback((x: number) => {
    setVolume(x)
    setMuted(x === 0)
    keep('volume', x)
    keep('muted', x === 0)
  }, [])
  const mute = () => {
    if (muted || volume === 0) {
      if (volume === 0) setVol(0.5)
      else { setMuted(false); keep('muted', false) }
    } else { setMuted(true); keep('muted', true) }
  }
  const caption = () => { setCaptions(!captions); keep('captions', !captions) }
  const speed = (d: number) => setRate(r => RATES[Math.max(0, Math.min(RATES.length - 1, RATES.indexOf(r) - d))] ?? r)
  const fullscreen = () => {
    const el = shell.current
    const v = video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    else if (el?.requestFullscreen) el.requestFullscreen().catch(() => {})
    else v?.webkitEnterFullscreen?.() // (an iPhone puts only the video itself on the whole screen)
  }
  const canPip = typeof document !== 'undefined' && document.pictureInPictureEnabled
  const pip = () => {
    const v = video.current
    if (!v) return
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {})
    else v.requestPictureInPicture().catch(() => {})
  }
  useEffect(() => {
    const on = () => setFull(!!shell.current && document.fullscreenElement === shell.current)
    document.addEventListener('fullscreenchange', on)
    return () => document.removeEventListener('fullscreenchange', on)
  }, [])

  // keys (a focused button, link, slider or list row answers its own space and enter)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (e.metaKey || e.ctrlKey || e.altKey || el.closest?.('input, textarea, select, [contenteditable]')) return
      if ((e.key === ' ' || e.key === 'Enter') && el.closest?.('button, a, [role="slider"]')) return
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
      if (k === ' ' || k === 'k') { e.preventDefault(); toggle(true) }
      else if (k === 'ArrowLeft') step(-1)
      else if (k === 'ArrowRight') step(1)
      else if (k === 'j') seekTo((video.current?.currentTime ?? 0) - 5)
      else if (k === 'l') seekTo((video.current?.currentTime ?? 0) + 5)
      else if (k === 'm') mute()
      else if (k === 'c') caption()
      else if (k === 'f') fullscreen()
      else if (k === '<' || k === '>') speed(k === '>' ? 1 : -1)
      else if (/^[0-9]$/.test(k)) seekTo((Number(k) / 10) * duration)
      else if (k === 'Escape') { if (menu) setMenu(null); else setRepeat(null) }
      else return
      wake()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  // Auto steps down to 360p when 720p keeps the clip waiting (a long stall, or two in twenty seconds); it doesn't
  // step back up on its own
  const begun = useRef(false)
  const stalledAt = useRef(0)
  const stalls = useRef<number[]>([])
  const onWaiting = () => {
    setWaiting(true)
    const v = video.current
    if (begun.current && v && !v.seeking && !swap.current) stalledAt.current = performance.now()
  }
  const onPlaying = () => {
    setWaiting(false)
    begun.current = true
    if (!stalledAt.current) return
    const now = performance.now()
    const long = now - stalledAt.current > 1500
    stalledAt.current = 0
    stalls.current = [...stalls.current.filter(at => now - at < 20000), now]
    if (quality === 'auto' && source?.key === 'hd' && low && (long || stalls.current.length >= 2)) { hold(); setSlow(true) }
  }
  const onProgress = () => {
    const v = video.current
    if (!v || !v.duration) return
    let end = 0
    for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.5) end = Math.max(end, v.buffered.end(i))
    setBuffered(end / v.duration)
  }
  const tries = useRef(0)

  const star = () => write('PATCH', `/api/moments/${m.id}`, { starred: !m.starred }).catch(() => {})
  const thumb = thumbOf(m)
  const started = t >= 0
  const shownT = Math.max(0, Math.min(t, duration))
  const line = current >= 0 ? m.sentences[current] : null
  const lit = useMemo(() => m.sentences.map((s, i) => marks(s.text, s.words.map(w => w[0]),
    m.expressions.filter(e => e.s === i).map(e => [e.a, e.b] as [number, number]))), [m.sentences, m.expressions])
  // (a tap on a phone while the controls are away only brings them back)
  const woke = useRef(false)

  return (
    <div className="moment" data-in="col">
      {source ? (
        <div
          ref={shell} className="player" data-idle={resting || undefined}
          onPointerMove={e => { if (e.pointerType === 'mouse') wake() }}
          onPointerLeave={() => { if (playing) wake(700) }}
          onFocus={() => wake()}
        >
          <div className="plate">
            <video
              ref={video}
              key={m.id}
              src={source.src + (retry ? `?r=${retry}` : '')}
              poster={(m.poster ? media(m.poster) : thumb) || undefined}
              playsInline
              preload="metadata"
              onPlay={e => {
                if (cover.current) { cover.current = false; e.currentTarget.currentTime = 0 }
                setPlaying(true); setEnded(false); wake()
              }}
              onPause={() => { if (!swap.current) setPlaying(false) }}
              onEnded={() => { setPlaying(false); setEnded(true); setT(1e9) }}
              onLoadedMetadata={e => {
                const v = e.currentTarget
                setDuration(v.duration || m.duration)
                v.defaultPlaybackRate = rate
                v.playbackRate = rate
                if (swap.current) v.currentTime = Math.min(swap.current.t, Math.max(0, v.duration - 0.05))
                else if (!m.poster && t < 0 && start === undefined) { cover.current = true; v.currentTime = Math.min(4, v.duration / 3) }
              }}
              onSeeked={e => { if (swap.current) resumed(); else if (!playing && !cover.current) setT(e.currentTarget.currentTime) }}
              onWaiting={onWaiting}
              onPlaying={onPlaying}
              onCanPlay={() => setWaiting(false)}
              onProgress={onProgress}
              onTimeUpdate={onProgress}
              onError={() => {
                // (a signed link runs out after hours on pause, a connection drops: ask for the clip again, once or twice)
                if (tries.current >= 2) return
                tries.current += 1
                hold()
                setRetry(r => r + 1)
              }}
            />
            <canvas ref={still} className="player-still" aria-hidden />
            <div
              className="player-hit" aria-hidden
              onPointerDown={e => { woke.current = e.pointerType !== 'mouse' && resting; if (woke.current) wake() }}
              onClick={() => { if (woke.current) woke.current = false; else { toggle(true); wake() } }}
              onDoubleClick={fullscreen}
            />
            {captions && line && (
              <p className="player-cue" aria-live="off">
                {line.words.map(([w, ws], j) => (
                  <span key={`${current}-${j}`}>
                    {j > 0 && ' '}
                    <span className="w" data-said={ws <= t || undefined} data-x={lit[current][j] || undefined}>{w}</span>
                  </span>
                ))}
              </p>
            )}
            {t < 0 && !playing && <span className="player-flash player-start" aria-hidden><PlayIcon /></span>}
            {flash && (
              <span key={flash.n} className="player-flash" aria-hidden>{flash.play ? <PlayIcon /> : <PauseIcon />}</span>
            )}
            {waiting && playing && <span className="player-wait" aria-hidden><i /><i /><i /></span>}
            <div className="player-bar">
              <Seek t={shownT} duration={duration} buffered={buffered} sentences={m.sentences} onSeek={seekTo} onScrub={onScrub} />
              <div className="player-row">
                <button className="pbtn" type="button" onClick={() => toggle()} aria-label={ended ? 'Play again' : playing ? 'Pause' : 'Play'}>
                  {ended ? <ReplayIcon /> : playing ? <PauseIcon /> : <PlayIcon />}
                </button>
                <Volume volume={volume} muted={muted} onVolume={setVol} onMute={mute} />
                <span className="player-time" aria-hidden>{mmss(shownT)}<span> / {mmss(duration)}</span></span>
                <span className="player-gap" />
                <Choices
                  name="Speed" button={<span className="player-rate">{rate}×</span>}
                  options={RATES.map(r => ({ key: r, label: `${r}×` }))} value={rate} onPick={setRate}
                  open={menu === 'speed'} onOpen={o => setMenu(o ? 'speed' : null)}
                />
                <button className="pbtn" type="button" aria-pressed={captions} aria-label="Captions" title="Captions" onClick={caption}>
                  <CaptionsIcon />
                </button>
                {sources.length > 1 && (
                  <Choices
                    name="Quality" button={<SettingsIcon />}
                    options={[{ key: 'auto' as Quality, label: <>Auto <span className="pmenu-note">{source.h}p</span></> },
                      ...sources.map(s => ({ key: s.key as Quality, label: `${s.h}p` }))]}
                    value={quality} onPick={choose}
                    open={menu === 'quality'} onOpen={o => setMenu(o ? 'quality' : null)}
                  />
                )}
                {canPip && (
                  <button className="pbtn" type="button" aria-label="Picture in picture" title="Picture in picture" onClick={pip}><PipIcon /></button>
                )}
                <button className="pbtn" type="button" aria-label={full ? 'Exit full screen' : 'Full screen'} title={full ? 'Exit full screen' : 'Full screen'} onClick={fullscreen}>
                  {full ? <SmallIcon /> : <FullIcon />}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="plate plate-still">
          {thumb && <img src={thumb} alt="" />}
          <span className="plate-note">This moment’s video stayed on your computer.</span>
        </div>
      )}

      {(repeat !== null || (local && source) || m.vod) && (
        <div className="controls">
          {repeat !== null && (
            <button className="btn btn-solo" type="button" data-on onClick={() => setRepeat(null)}>
              <LoopIcon /><span>Repeating · Esc</span>
            </button>
          )}
          {local && source && (
            <button className="btn btn-solo" type="button" aria-pressed={m.starred} data-on={m.starred || undefined} onClick={star}
              style={{ '--tint': 'var(--mascot)' } as CSSProperties}>
              <StarIcon /><span>{m.starred ? 'Saved' : 'Save'}</span>
            </button>
          )}
          {m.vod && <a className="btn btn-solo" href={m.vod} target="_blank" rel="noreferrer"><OutIcon /><span>In the stream</span></a>}
        </div>
      )}

      <div className="moment-body">
        <div className="transcript" aria-label="Transcript">
          {m.sentences.map((s, i) => {
            const marked = lit[i]
            return (
              <p key={i} className="line" data-now={i === current || undefined} data-loop={i === repeat || undefined}
                onClick={source ? () => say(i) : undefined} title={source ? (i === repeat ? 'Stop repeating' : 'Hear it again and again') : undefined}>
                {s.words.map(([w, ws], j) => (
                  <span key={j}>
                    {j > 0 && ' '}
                    <span className="w" data-said={(started ? ws <= t : marked[j]) || undefined} data-x={marked[j] || undefined}>{w}</span>
                  </span>
                ))}
              </p>
            )
          })}
        </div>
        {side}
      </div>
    </div>
  )
}
