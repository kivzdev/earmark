import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { gsap, reduced } from '@/motion/gsap'
import { Link } from '@/router'
import { GROUP_NAME, media, shortDay, store, timeOf, write, type Heard } from '@/data'
import { LoopIcon, NextIcon, OutIcon, PauseIcon, PlayIcon, StarIcon } from './icons'

/** the words of a clip with the phrase's ones marked; spoken words turn white as the clip plays */
function words(c: Heard) {
  const list = c.words?.length ? c.words : c.sentence.split(' ').map(w => [w, 0, 0] as [string, number, number])
  const phrase = c.sentence.slice(c.match[0], c.match[1]).toLowerCase()
  let joined = ''
  const spans = list.map(([w]) => {
    const s = joined ? joined.length + 1 : 0
    joined += (joined ? ' ' : '') + w
    return [s, s + w.length]
  })
  const at = joined.toLowerCase().indexOf(phrase)
  return list.map(([w, s, e], i) => ({
    w, s, e,
    phrase: at >= 0 && spans[i][1] > at && spans[i][0] < at + phrase.length,
  }))
}

/** "another voice": the next clip said by someone else, or just the next one */
function nextVoice(list: Heard[], id: string) {
  const i = list.findIndex(h => h.id === id)
  const me = list[i]?.session.channel
  for (let k = 1; k < list.length; k++) {
    const h = list[(i + k) % list.length]
    if (h.session.channel !== me) return h.id
  }
  return list[(i + 1) % list.length]?.id ?? id
}

/**
 * One phrase's clips on a plate (a figure's plate on kivz.dev): the clip, its sentence lighting up word by word as it
 * plays, and plain controls under it. A new clip swaps the site's way — the old one blurs out where it stands, the
 * new one blurs in — and a swap under way is never cut short: picks made meanwhile wait, and only the last one plays.
 */
export function Player({ list, current, onPick }: { list: Heard[]; current: string; onPick: (id: string) => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(current)
  const [playing, setPlaying] = useState(false)
  const [loop, setLoop] = useState(false)
  const [t, setT] = useState(-1)
  const busy = useRef(false)
  const wanted = useRef(current)
  const autoplay = useRef(false)
  const c = list.find(h => h.id === shown) ?? list[0]
  const local = store().meta?.mode === 'local'

  const out = () => {
    busy.current = true
    if (reduced()) return setShown(wanted.current)
    gsap.to(stage.current, { autoAlpha: 0, filter: 'blur(4px)', duration: 0.2, ease: 'sine.in', overwrite: 'auto',
      onComplete: () => setShown(wanted.current) })
  }
  useEffect(() => {
    wanted.current = current
    if (busy.current || current === shown) return
    autoplay.current = true
    out()
  }, [current])

  // the new clip is in: bring it in, play it if it was picked, then catch up with any pick made meanwhile
  useEffect(() => {
    setT(-1)
    if (!busy.current) return
    const v = video.current!
    let done = false
    const reveal = () => {
      if (done) return
      done = true
      if (autoplay.current) v.play().catch(() => {})
      const finish = () => { busy.current = false; if (wanted.current !== shown) out() }
      if (reduced()) { gsap.set(stage.current, { autoAlpha: 1, filter: 'none' }); return finish() }
      gsap.to(stage.current, { autoAlpha: 1, filter: 'blur(0px)', duration: 0.45, ease: 'sine.out', overwrite: 'auto',
        clearProps: 'filter', onComplete: finish })
    }
    if (v.readyState >= 2) reveal()
    else {
      v.addEventListener('loadeddata', reveal, { once: true })
      const late = setTimeout(reveal, 1200) // a slow clip doesn't hold the swap
      return () => { clearTimeout(late); v.removeEventListener('loadeddata', reveal) }
    }
  }, [shown])

  // the words follow the clip, frame by frame while it plays
  useEffect(() => {
    if (!playing) return
    let id = 0
    const step = () => { setT(video.current?.currentTime ?? 0); id = requestAnimationFrame(step) }
    id = requestAnimationFrame(step)
    return () => cancelAnimationFrame(id)
  }, [playing])

  const toggle = () => {
    const v = video.current!
    if (v.paused) v.play().catch(() => {})
    else v.pause()
  }
  const star = () => { write('PATCH', `/api/catches/${c.id}`, { starred: !c.starred }).catch(() => {}) }
  const others = new Set(list.map(h => h.session.channel)).size > 1 || list.length > 1

  if (!c) return null
  const said = words(c)
  const s = c.session
  return (
    <div className="player" data-in="col">
      <div className="player-stage" ref={stage}>
        <div className="plate" onClick={toggle}>
          <video
            ref={video}
            key={c.id}
            src={media(c.clip!) + (c.poster ? '' : '#t=0.05')}
            poster={c.poster ? media(c.poster) : undefined}
            loop={loop}
            playsInline
            preload="metadata"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => { setPlaying(false); setT(1e9) }}
          />
        </div>
        <p className="karaoke">
          {said.map((x, i) => (
            <span key={i}>
              {i > 0 && ' '}
              <span className="w" data-on={(t < 0 ? x.phrase : x.s <= t) || undefined} data-phrase={x.phrase || undefined}>{x.w}</span>
            </span>
          ))}
        </p>
        <p className="muted">
          <Link className="u" href={`/streamers/${s.channel}`}>{s.displayName}</Link>
          {' · '}{s.game || GROUP_NAME[s.group]}{' · '}{shortDay(c.at)}, {timeOf(c.at)}
        </p>
      </div>
      <div className="controls">
        <button className="btn btn-solo" type="button" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <PauseIcon /> : <PlayIcon />}<span className="fixed" data-w="Pause">{playing ? 'Pause' : 'Play'}</span>
        </button>
        <button className="btn btn-solo" type="button" aria-pressed={loop} data-on={loop || undefined} onClick={() => setLoop(l => !l)}>
          <LoopIcon /><span>Loop</span>
        </button>
        {others && (
          <button className="btn btn-solo" type="button" onClick={() => onPick(nextVoice(list, c.id))}>
            <NextIcon /><span>Another voice</span>
          </button>
        )}
        {local && (
          <button className="btn btn-solo" type="button" aria-pressed={c.starred} data-on={c.starred || undefined} onClick={star}
            style={{ '--tint': 'var(--mascot)' } as CSSProperties}>
            <StarIcon /><span>{c.starred ? 'Starred' : 'Star'}</span>
          </button>
        )}
        {c.vod && (
          <a className="btn btn-solo" href={c.vod} target="_blank" rel="noreferrer"><OutIcon /><span>On Twitch</span></a>
        )}
      </div>
    </div>
  )
}
