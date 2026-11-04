import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { IconContext } from '@phosphor-icons/react'
import { gsap, useGSAP, reduced } from '@/motion/gsap'
import { onReveal, playReveal, revealed } from '@/motion/stage'
import { Link, usePath } from '@/router'
import { signOut } from '@/auth'
import { start, useStore } from '@/data'
import { Mark, PhrasesIcon, SettingsIcon, SignOutIcon, StreamsIcon, TodayIcon } from '@/ui/icons'
import { usePill } from '@/ui/pill'
import { Login } from '@/pages/Login'
import { Missing, Phrase, Phrases, Streamer, Streams, Today } from '@/pages/pages'
import { Settings } from '@/pages/Settings'

// the rail's sections, each with the colour its icon takes with the highlight (kivz.dev's palette: pink, blue, the
// mascot's yellow, green)
const NAV = [
  { id: 'today', href: '/', label: 'Today', Icon: TodayIcon, tint: 'var(--pink)' },
  { id: 'phrases', href: '/phrases', label: 'Phrases', Icon: PhrasesIcon, tint: 'var(--blue)' },
  { id: 'streams', href: '/streams', label: 'Streams', Icon: StreamsIcon, tint: 'var(--mascot)' },
  { id: 'settings', href: '/settings', label: 'Settings', Icon: SettingsIcon, tint: 'var(--green)' },
] as const
const tint = (c: string) => ({ '--tint': c }) as CSSProperties

function routeOf(path: string) {
  let m
  if (path === '/') return { name: 'today', section: 'today' } as const
  if ((m = path.match(/^\/day\/(\d{4}-\d{2}-\d{2})$/))) return { name: 'day', section: 'today', key: m[1] } as const
  if (path === '/phrases') return { name: 'phrases', section: 'phrases' } as const
  if ((m = path.match(/^\/phrases\/([\w-]+)$/))) return { name: 'phrase', section: 'phrases', id: m[1] } as const
  if (path === '/streams') return { name: 'streams', section: 'streams' } as const
  if ((m = path.match(/^\/streamers\/([a-z0-9_]+)$/))) return { name: 'streamer', section: 'streams', login: m[1] } as const
  if (path === '/settings') return { name: 'settings', section: 'settings' } as const
  return { name: 'missing', section: null } as const
}
type Route = ReturnType<typeof routeOf>

const titleOf = (r: Route) =>
  ({ today: 'Today', day: 'A day', phrases: 'Phrases', phrase: 'A phrase', streams: 'Streams', streamer: 'A streamer',
    settings: 'Settings', missing: 'Not found' })[r.name] + ' — Earmark'

/**
 * Earmark's frame, kivz.dev's: the rail on the left (the mark, the sections) and one column of text centred on the
 * page. Only the column changes from page to page; the old page blurs out where it stands and the new one blurs in.
 */
export function Shell() {
  const root = useRef<HTMLDivElement>(null)
  const nav = useRef<HTMLElement>(null)
  const path = usePath()
  const [shown, setShown] = useState(path)
  const { meta, error } = useStore()
  const cloud = meta?.mode === 'cloud'
  const locked = cloud && !meta?.authed
  const items = NAV.filter(n => n.id !== 'settings' || !cloud)
  const want = routeOf(path), route = routeOf(shown)

  useEffect(start, [])
  usePill(nav, locked ? -1 : items.findIndex(n => n.id === want.section))

  // the top edge: what scrolls under it softens and fades in over the first 80 px of scroll
  const scrim = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scrim.current!
    const set = () => {
      const p = Math.min(1, scrollY / 80)
      el.style.setProperty('--scrim', String(p * p * (3 - 2 * p)))
    }
    set()
    addEventListener('scroll', set, { passive: true })
    return () => removeEventListener('scroll', set)
  }, [])

  // entrance: everything waits hidden until the helper (or the cloud) has answered, then the rail and the column rise
  // into place one after another, arriving at speed and settling
  useGSAP(() => {
    const r = root.current!
    const q = (s: string) => [...r.querySelectorAll<HTMLElement>(s)]
    gsap.set([...q('[data-in]'), ...q('.pill')], { autoAlpha: 0 })
    return onReveal(() => {
      const rail = q('[data-in="rail"]'), col = q('.page [data-in]')
      const pills = q('.pills').filter(g => g.querySelector('[data-on]')).map(g => g.querySelector<HTMLElement>('.pill')!)
      const tl = gsap.timeline()
      if (reduced()) return tl.to([...rail, ...pills, ...col], { autoAlpha: 1, duration: 0.4 })
      return tl
        .fromTo(rail, { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.8, ease: 'settle', stagger: 0.05 }, 0)
        .to(pills, { autoAlpha: 1, duration: 0.5 }, 0.25)
        .fromTo(col, { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.9, ease: 'settle', stagger: 0.055 }, 0.05)
    })
  }, { scope: root })
  useEffect(() => { if ((meta || error) && !revealed()) requestAnimationFrame(() => playReveal()) }, [meta, error])

  // a new page: the one on screen blurs out where it stands, then the new one blurs in in its place — nothing slides.
  // Back to the page still on screen before it has gone: it just comes back.
  useGSAP(() => {
    const page = root.current!.querySelector('.page')
    if (path === shown) {
      if (page && revealed()) gsap.to(page, { autoAlpha: 1, filter: 'blur(0px)', duration: 0.3, ease: 'sine.out', overwrite: 'auto' })
      return
    }
    if (!page || !revealed()) { setShown(path); return }
    gsap.to(page, { autoAlpha: 0, filter: 'blur(4px)', duration: 0.2, ease: 'sine.in', overwrite: 'auto',
      onComplete: () => { scrollTo(0, 0); setShown(path) } })
  }, { dependencies: [path] })
  const first = useRef(true)
  useGSAP(() => {
    if (first.current) { first.current = false; return }
    const page = root.current!.querySelector('.page')
    if (page) gsap.set(page, { autoAlpha: 1, filter: 'none' })
    gsap.fromTo(root.current!.querySelectorAll('.page [data-in]'), { autoAlpha: 0, filter: 'blur(4px)' },
      { autoAlpha: 1, filter: 'blur(0px)', duration: 0.45, ease: 'sine.out', stagger: 0.03, clearProps: 'filter' })
  }, { dependencies: [shown, locked] })
  const { library } = useStore()
  useEffect(() => {
    const named = route.name === 'phrase' ? library?.patterns.find(p => p.id === route.id)?.label
      : route.name === 'streamer' ? library?.sessions.find(s => s.channel === route.login)?.displayName : null
    document.title = locked ? 'Earmark' : named ? `${named} — Earmark` : titleOf(route)
  }, [shown, locked, library])

  const page =
    error && !meta ? <Down key="down" error={error} />
    : locked ? <Login key="login" setup={!!meta?.setup} />
    : route.name === 'today' ? <Today key={shown} />
    : route.name === 'day' ? <Today key={shown} day={route.key} />
    : route.name === 'phrases' ? <Phrases key={shown} />
    : route.name === 'phrase' ? <Phrase key={shown} id={route.id} />
    : route.name === 'streams' ? <Streams key={shown} />
    : route.name === 'streamer' ? <Streamer key={shown} login={route.login} />
    : route.name === 'settings' && !cloud ? <Settings key={shown} />
    : <Missing key={shown} />

  return (
    <IconContext.Provider value={{ weight: 'fill', size: 14 }}>
      <div className="site" ref={root}>
        <div className="scrim" ref={scrim} aria-hidden><i /><i /><i /><i /></div>
        <aside className="rail rail-l">
          <Link className="logo" href="/" aria-label="Earmark" data-in="rail"><Mark /></Link>
          <nav className="pills nav" ref={nav} aria-label="Main" hidden={locked}>
            <span className="pill" aria-hidden />
            {items.map(({ id, href, label, Icon, tint: c }) => (
              <Link key={id} className="btn" href={href} data-pill data-in="rail" data-nav={id} style={tint(c)}
                aria-current={want.section === id ? 'page' : undefined}>
                <Icon /><span>{label}</span>
              </Link>
            ))}
          </nav>
          {cloud && meta?.authed && (
            <button className="btn btn-solo rail-out" type="button" data-in="rail" onClick={signOut} style={tint('var(--fg)')}>
              <SignOutIcon /><span>Sign out</span>
            </button>
          )}
        </aside>
        <main className="col">{page}</main>
      </div>
    </IconContext.Provider>
  )
}

/** the helper isn't answering */
function Down({ error }: { error: string }) {
  return (
    <div className="page">
      <header className="hello">
        <h1 data-in="col">Earmark isn’t answering</h1>
        <p className="muted" data-in="col">Start it on this computer with <code className="kbd">earmark</code>, then reload.</p>
      </header>
      <p className="muted" data-in="col">{error}</p>
    </div>
  )
}
