import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { media, store, thumbOf, write, type Seen } from '@/data'
import { usePill } from './pill'
import { LoopIcon, OutIcon, PauseIcon, PlayIcon, StarIcon } from './icons'

const RATES = [1, 0.75, 0.5]

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

/**
 * A moment on a plate: the clip, its transcript lighting up word by word as it's said, the expressions in it
 * underlined. Click a sentence to hear it again and again (click it once more to go on); slow it down to catch the
 * quick, swallowed bits. Space plays and pauses; ← and → move a sentence.
 */
export function MomentPlayer({ m, start }: { m: Seen; start?: number }) {
  const video = useRef<HTMLVideoElement>(null)
  const rates = useRef<HTMLDivElement>(null)
  const [t, setT] = useState(-1)
  const [playing, setPlaying] = useState(false)
  const [rate, setRate] = useState(1)
  const [repeat, setRepeat] = useState<number | null>(null)
  const local = store().meta?.mode === 'local'
  usePill(rates, RATES.indexOf(rate))

  const current = t < 0 ? -1 : m.sentences.findIndex((s, i) => t < (m.sentences[i + 1]?.t0 ?? 1e9) && t >= s.t0 - 0.3)
  const repeating = repeat !== null ? m.sentences[repeat] : null

  // follow the clip frame by frame while it plays; a repeated sentence goes back to its start when it's done
  useEffect(() => {
    if (!playing) return
    let id = 0
    const step = () => {
      const v = video.current
      if (v) {
        if (repeating && v.currentTime > repeating.t1 + 0.25) v.currentTime = Math.max(0, repeating.t0 - 0.15)
        setT(v.currentTime)
      }
      id = requestAnimationFrame(step)
    }
    id = requestAnimationFrame(step)
    return () => cancelAnimationFrame(id)
  }, [playing, repeating])

  useEffect(() => { if (video.current) video.current.playbackRate = rate }, [rate])

  // opened at a sentence (from an expression): start there
  useEffect(() => {
    const v = video.current
    if (start === undefined || !v || !m.sentences[start]) return
    const go = () => { v.currentTime = Math.max(0, m.sentences[start].t0 - 0.15); setT(v.currentTime) }
    if (v.readyState >= 1) go()
    else v.addEventListener('loadedmetadata', go, { once: true })
  }, [start, m.id])

  const toggle = () => {
    const v = video.current
    if (!v) return
    if (v.paused) v.play().catch(() => {})
    else v.pause()
  }
  const say = (i: number) => {
    const v = video.current
    if (!v || !m.sentences[i]) return
    if (repeat === i) { setRepeat(null); return }
    setRepeat(i)
    v.currentTime = Math.max(0, m.sentences[i].t0 - 0.15)
    setT(v.currentTime)
    v.play().catch(() => {})
  }
  const step = (d: number) => {
    const v = video.current
    if (!v) return
    const i = Math.max(0, Math.min(m.sentences.length - 1, (current < 0 ? 0 : current) + d))
    v.currentTime = Math.max(0, m.sentences[i].t0 - 0.15)
    setT(v.currentTime)
    if (repeat !== null) setRepeat(i)
  }

  // keys: space, ← →
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === ' ') { e.preventDefault(); toggle() }
      else if (e.key === 'ArrowLeft') step(-1)
      else if (e.key === 'ArrowRight') step(1)
      else if (e.key === 'Escape') setRepeat(null)
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  const star = () => write('PATCH', `/api/moments/${m.id}`, { starred: !m.starred }).catch(() => {})
  const thumb = thumbOf(m)
  const started = t >= 0

  return (
    <div className="moment" data-in="col">
      <div className="plate" onClick={m.clip ? toggle : undefined}>
        {m.clip ? (
          <video
            ref={video}
            key={m.id}
            src={media(m.clip) + (m.poster && local ? '' : '#t=0.05')}
            poster={(local && m.poster ? media(m.poster) : thumb) || undefined}
            playsInline
            preload="metadata"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => { setPlaying(false); setT(1e9) }}
          />
        ) : (
          <>
            {thumb && <img src={thumb} alt="" />}
            <span className="plate-note">This moment’s video stayed on your computer.</span>
          </>
        )}
      </div>

      {m.clip && (
        <div className="controls">
          <button className="btn btn-solo" type="button" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? <PauseIcon /> : <PlayIcon />}<span className="fixed" data-w="Pause">{playing ? 'Pause' : 'Play'}</span>
          </button>
          <div className="pills pills-x" ref={rates} role="group" aria-label="Speed">
            <span className="pill" aria-hidden />
            {RATES.map(r => (
              <button key={r} className="btn" type="button" data-pill aria-pressed={rate === r} onClick={() => setRate(r)}>{r}×</button>
            ))}
          </div>
          {repeat !== null && (
            <button className="btn btn-solo" type="button" data-on onClick={() => setRepeat(null)}>
              <LoopIcon /><span>Repeating · Esc</span>
            </button>
          )}
          {local && (
            <button className="btn btn-solo" type="button" aria-pressed={m.starred} data-on={m.starred || undefined} onClick={star}
              style={{ '--tint': 'var(--mascot)' } as CSSProperties}>
              <StarIcon /><span>{m.starred ? 'Saved' : 'Save'}</span>
            </button>
          )}
          {m.vod && <a className="btn btn-solo" href={m.vod} target="_blank" rel="noreferrer"><OutIcon /><span>In the stream</span></a>}
        </div>
      )}

      <div className="transcript" aria-label="Transcript">
        {m.sentences.map((s, i) => {
          const spans = m.expressions.filter(e => e.s === i).map(e => [e.a, e.b] as [number, number])
          const lit = marks(s.text, s.words.map(w => w[0]), spans)
          return (
            <p key={i} className="line" data-now={i === current || undefined} data-loop={i === repeat || undefined}
              onClick={m.clip ? () => say(i) : undefined} title={m.clip ? (i === repeat ? 'Stop repeating' : 'Hear it again and again') : undefined}>
              {s.words.map(([w, ws], j) => (
                <span key={j}>
                  {j > 0 && ' '}
                  <span className="w" data-said={(started ? ws <= t : lit[j]) || undefined} data-x={lit[j] || undefined}>{w}</span>
                </span>
              ))}
            </p>
          )
        })}
      </div>
    </div>
  )
}
