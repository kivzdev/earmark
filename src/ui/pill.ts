import { useRef, type RefObject } from 'react'
import { gsap, useGSAP } from '@/motion/gsap'
import { revealed } from '@/motion/stage'

/**
 * One highlight under a group of equal controls (the `[data-pill]` children, plus one `.pill` element): it rests under
 * the active control and glides to whichever one is hovered or focused, a touch past and back ('spring'). The control
 * the highlight is under is lit (`data-on`), so the colour follows the highlight rather than the cursor. With no active
 * control (`active` -1: the missing page, for the rail's sections — or one the layout hides, the Home tab on a phone)
 * it rests nowhere: it fades in under a hovered control and fades out where it is when the pointer leaves.
 */
export function usePill(group: RefObject<HTMLElement | null>, active: number) {
  const api = useRef<{ go(i: number, glide?: boolean): void; rest: number } | null>(null)

  useGSAP(() => {
    const el = group.current
    if (!el) return // (a group the page doesn't show right now)
    const pill = el.querySelector<HTMLElement>('.pill')!
    const items = [...el.querySelectorAll<HTMLElement>('[data-pill]')]
    let at = -1
    const go = (i: number, glide = true) => {
      // (a control the layout hides is as good as none: there's nothing to rest under)
      const b = items[i]?.offsetWidth ? items[i] : undefined
      items.forEach((it, j) => it.toggleAttribute('data-on', j === i))
      // (before the page is revealed its visibility is the entrance's business, not this)
      if (!b) {
        if (revealed()) gsap.to(pill, { autoAlpha: 0, duration: 0.25, ease: 'sine.out', overwrite: 'auto' })
        at = -1
        return
      }
      const to = { x: b.offsetLeft, y: b.offsetTop, width: b.offsetWidth, height: b.offsetHeight }
      if (glide && at >= 0) gsap.to(pill, { ...to, duration: 0.5, ease: 'spring', overwrite: 'auto' })
      else gsap.set(pill, { ...to, overwrite: 'auto' })
      if (at < 0 && revealed()) gsap.to(pill, { autoAlpha: 1, duration: 0.25, ease: 'sine.out', overwrite: 'auto' })
      at = i
    }
    const state = { go, rest: active }
    api.current = state
    go(active, false)

    const on = (e: Event) => go(items.indexOf(e.currentTarget as HTMLElement))
    const off = () => go(state.rest)
    const blur = (e: FocusEvent) => { if (!el.contains(e.relatedTarget as Node)) off() }
    for (const b of items) { b.addEventListener('pointerenter', on); b.addEventListener('focus', on) }
    el.addEventListener('pointerleave', off)
    el.addEventListener('focusout', blur)
    // labels change width with the language, fonts arrive late, a hidden control comes back as the page widens: keep
    // the highlight on its control
    const ro = new ResizeObserver(() => { if (at >= 0 || state.rest >= 0) go(at >= 0 ? at : state.rest, false) })
    ro.observe(el)
    return () => {
      for (const b of items) { b.removeEventListener('pointerenter', on); b.removeEventListener('focus', on) }
      el.removeEventListener('pointerleave', off)
      el.removeEventListener('focusout', blur)
      ro.disconnect()
    }
  })

  // a new active control (a click, a new page): the highlight is usually already there, otherwise it glides over
  useGSAP(() => {
    if (!api.current) return
    api.current.rest = active
    api.current.go(active)
  }, { dependencies: [active] })
}
