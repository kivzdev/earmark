import type { CSSProperties } from 'react'

// The skeleton: while something the page waits for is on its way (Spotify's song, …), a quiet placeholder in its shape
// stands in for it — a bar for a line of text, a block for an image — inside the very elements the real thing will
// fill, so its line, size and place are already the real ones and nothing moves when it lands. A quick answer never
// shows it: it waits a beat, fades in, then breathes, each part a little after the one above it (home.css .skel). The
// real thing takes over the site's way: the skeleton blurs out where it stands, then the real thing blurs in in its
// place (Home.tsx, the song). The user, 2026-11-03: the design's song showed for a moment, then changed.

/** a placeholder: a line of text `w` px long, or with `box` a block its own class sizes (a cover); `i` is its row
 *  from the top, so the breathing runs down the parts */
export function Skel({ w, i = 0, box = false, className = '' }: { w?: number; i?: number; box?: boolean; className?: string }) {
  const cls = ['skel', !box && 'skel-line', className].filter(Boolean).join(' ')
  return <span className={cls} style={{ width: w, '--i': i } as CSSProperties} aria-hidden />
}
