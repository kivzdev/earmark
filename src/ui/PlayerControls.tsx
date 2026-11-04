import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import type { Sentence } from '@/data'
import { MutedIcon, VolumeIcon, VolumeLowIcon } from './icons'
import { usePill } from './pill'

/** a player's clock: minutes and whole seconds (it never shows 0:60) */
export const mmss = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

/** the sentence being said at `t` (one starts a beat early: its first sound comes before its first word's time) */
export function sentenceAt(sentences: Sentence[], t: number) {
  let at = -1
  sentences.forEach((s, i) => { if (t >= s.t0 - 0.3) at = i })
  return at
}

/**
 * The progress bar. It's cut where each sentence starts, so it reads as the moment's sentences; what you've heard is
 * white, what's loaded a lighter grey. Over it, the sentence said at that point and its time; press and drag to scrub.
 * It grows a little under the pointer, and its knob comes out. Keys: ← → five seconds, Home, End.
 */
export function Seek({ t, duration, buffered, sentences, onSeek, onScrub }: {
  t: number; duration: number; buffered: number; sentences: Sentence[]
  onSeek: (t: number) => void
  onScrub: (dragging: boolean) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<{ t: number; x: number; w: number } | null>(null)
  const [shown, setShown] = useState(false)
  const [drag, setDrag] = useState(false)
  const d = duration > 0 ? duration : 1

  // (a 2 px gap where each sentence begins)
  const gaps = useMemo(() => {
    const at = sentences.slice(1).map(s => (s.t0 / d) * 100).filter(p => p > 1 && p < 99)
    if (!at.length) return undefined
    const cut = at.map(p => `#000 calc(${p.toFixed(3)}% - 1px), transparent calc(${p.toFixed(3)}% - 1px) calc(${p.toFixed(3)}% + 1px), #000 calc(${p.toFixed(3)}% + 1px)`)
    return `linear-gradient(90deg, #000 0, ${cut.join(', ')}, #000 100%)`
  }, [sentences, d])

  const where = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect()
    const f = clamp01((clientX - r.left) / r.width)
    return { t: f * d, x: f * r.width, w: r.width }
  }
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const h = where(e.clientX)
    setDrag(true); setHover(h); setShown(true)
    onScrub(true)
    onSeek(h.t)
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const h = where(e.clientX)
    setHover(h); setShown(true)
    if (drag) onSeek(h.t)
  }
  const up = () => {
    if (!drag) return
    setDrag(false)
    onScrub(false)
  }
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const by = ({ ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5, PageDown: -10, PageUp: 10 } as Record<string, number>)[e.key]
    if (by !== undefined) onSeek(Math.max(0, Math.min(d, t + by)))
    else if (e.key === 'Home') onSeek(0)
    else if (e.key === 'End') onSeek(d)
    else return
    e.preventDefault()
    e.stopPropagation() // (the page's own ← → move a sentence)
  }

  const said = hover ? sentences[sentenceAt(sentences, hover.t)] : undefined
  const p = clamp01(t / d)
  return (
    <div
      ref={ref} className="seek" role="slider" tabIndex={0} aria-label="Seek"
      aria-valuemin={0} aria-valuemax={Math.round(d)} aria-valuenow={Math.round(Math.min(t, d))} aria-valuetext={`${mmss(Math.min(t, d))} of ${mmss(d)}`}
      data-drag={drag || undefined}
      style={{ '--p': p, '--b': Math.max(p, clamp01(buffered)), '--h': hover ? hover.t / d : 0 } as CSSProperties}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onLostPointerCapture={up}
      onPointerLeave={() => { if (!drag) setShown(false) }} onKeyDown={key}
    >
      <div className="seek-track" style={{ maskImage: gaps, WebkitMaskImage: gaps }}>
        <i className="seek-buf" />
        <i className="seek-hover" />
        <i className="seek-fill" />
      </div>
      <div className="seek-head"><i className="seek-knob" /></div>
      <div className="seek-tip" data-show={(shown && hover) || undefined}
        style={hover ? ({ '--x': `${hover.x}px`, '--w': `${hover.w}px` } as CSSProperties) : undefined}>
        {said && <span className="seek-said">{said.text}</span>}
        <span className="seek-at">{hover ? mmss(hover.t) : ''}</span>
      </div>
    </div>
  )
}

/**
 * Volume: the speaker mutes and unmutes; beside it a slider slides out under the pointer (or with the keyboard on
 * it): drag, scroll, or ← →.
 */
export function Volume({ volume, muted, onVolume, onMute }: {
  volume: number; muted: boolean
  onVolume: (v: number) => void
  onMute: () => void
}) {
  const rail = useRef<HTMLDivElement>(null)
  const slider = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState(false)
  const level = muted ? 0 : volume
  const at = (clientX: number) => {
    const r = rail.current!.getBoundingClientRect()
    onVolume(clamp01((clientX - r.left) / r.width))
  }
  // a scroll over the slider turns it (React's wheel listener can't keep the page from scrolling too)
  const now = useRef(level)
  now.current = level
  useEffect(() => {
    const el = slider.current!
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      onVolume(clamp01(now.current - Math.sign(e.deltaY) * 0.05))
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [onVolume])
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const by = ({ ArrowLeft: -0.1, ArrowDown: -0.1, ArrowRight: 0.1, ArrowUp: 0.1 } as Record<string, number>)[e.key]
    if (by !== undefined) onVolume(clamp01(level + by))
    else if (e.key === 'Home') onVolume(0)
    else if (e.key === 'End') onVolume(1)
    else return
    e.preventDefault()
    e.stopPropagation()
  }
  const Icon = level === 0 ? MutedIcon : level < 0.5 ? VolumeLowIcon : VolumeIcon
  return (
    <div className="vol" data-drag={drag || undefined}>
      <button className="pbtn" type="button" onClick={onMute} aria-label={level === 0 ? 'Unmute' : 'Mute'}><Icon /></button>
      <div
        ref={slider} className="vol-slider" role="slider" tabIndex={0} aria-label="Volume"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}
        style={{ '--v': level } as CSSProperties}
        onPointerDown={e => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); setDrag(true); at(e.clientX) }}
        onPointerMove={e => { if (drag) at(e.clientX) }}
        onPointerUp={() => setDrag(false)} onLostPointerCapture={() => setDrag(false)}
        onKeyDown={key}
      >
        <div className="vol-rail" ref={rail}>
          <div className="vol-track"><i className="vol-fill" /></div>
          <div className="vol-head"><i className="vol-knob" /></div>
        </div>
      </div>
    </div>
  )
}

export type Choice<K> = { key: K; label: ReactNode }

/**
 * A control that opens a short list above itself (speed, quality): the list grows out of its corner on a snappy
 * spring, its rows a beat apart, one highlight resting on the current choice. A choice closes it; so do Esc and a
 * click anywhere else. ↑ ↓ move between rows.
 */
export function Choices<K extends string | number>({ name, button, options, value, onPick, open, onOpen }: {
  name: string; button: ReactNode; options: Choice<K>[]; value: K
  onPick: (key: K) => void
  open: boolean
  onOpen: (open: boolean) => void
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const viaKeys = useRef(false)
  const close = useRef(onOpen)
  close.current = onOpen
  usePill(list, options.findIndex(o => o.key === value))

  useEffect(() => {
    if (!open) return
    // (opened from the keyboard: the current choice takes the focus)
    if (viaKeys.current) list.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()
    const away = (e: globalThis.PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) close.current(false) }
    addEventListener('pointerdown', away, true)
    return () => removeEventListener('pointerdown', away, true)
  }, [open])

  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const rows = [...list.current!.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
    const i = rows.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') rows[(i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus()
    else if (e.key === 'Escape') { onOpen(false); opener.current?.focus() }
    else if (e.key === 'Tab') onOpen(false)
    else return
    if (e.key !== 'Tab') e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div className="pmenu-wrap" ref={wrap}>
      <button ref={opener} className="pbtn" type="button" aria-haspopup="menu" aria-expanded={open} aria-label={name} title={name}
        onClick={e => { viaKeys.current = e.detail === 0; onOpen(!open) }}>
        {button}
      </button>
      <div className="pmenu" role="menu" aria-label={name} data-open={open || undefined} onKeyDown={key}>
        <p className="pmenu-label" aria-hidden>{name}</p>
        <div className="pills pmenu-list" ref={list}>
          <span className="pill" aria-hidden />
          {options.map((o, i) => (
            <button key={o.key} className="btn" type="button" role="menuitemradio" aria-checked={o.key === value} data-pill
              tabIndex={open ? 0 : -1} style={{ '--i': i } as CSSProperties}
              onClick={() => { onPick(o.key); onOpen(false); if (viaKeys.current) opener.current?.focus() }}>
              {o.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
