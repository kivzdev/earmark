import { gsap } from './gsap'

/**
 * The reveal hand-off. Sections register how they enter (`onReveal`); the intro calls `playReveal` once its curtain
 * starts lifting, and every entrance is laid into the intro's own timeline at that label — so the page's first
 * moves are timed against the curtain frame-exactly (no React state round trip, no setTimeout guessing).
 * Without an intro (?nointro, reduced motion) the same entrances play on a fresh timeline.
 */
type Part = { build: () => gsap.core.Animation | void; at: number }
const parts = new Set<Part>()
let played = false

/** `at` = seconds after the reveal label (negative = before the curtain is fully up). Returns an unregister fn. */
export function onReveal(build: Part['build'], at = 0) {
  const p = { build, at }
  parts.add(p)
  // registered after the reveal already happened (hot reload, late mount): just play it
  if (played) build()
  return () => { parts.delete(p) }
}

export function playReveal(tl: gsap.core.Timeline = gsap.timeline(), label?: string) {
  played = true
  const base = label ?? tl.duration()
  for (const p of [...parts].sort((a, b) => a.at - b.at)) {
    const anim = p.build()
    if (!anim) continue
    tl.add(anim, typeof base === 'string' ? `${base}${p.at < 0 ? '-=' : '+='}${Math.abs(p.at)}` : Math.max(0, base + p.at))
  }
  return tl
}

export const revealed = () => played
