import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { IconContext } from '@phosphor-icons/react'
import { gsap, useGSAP, reduced } from '@/motion/gsap'
import { onReveal, playReveal, revealed } from '@/motion/stage'
import { Link, usePath } from '@/router'
import { signOut } from '@/auth'
import { start, useStore } from '@/data'
import { HomeIcon, Mark, MomentsIcon, PhrasesIcon, SettingsIcon, SignOutIcon } from '@/ui/icons'
import { usePill } from '@/ui/pill'
import { Login } from '@/pages/Login'
import { Category, Channel, Expression, Expressions, Home, Missing, Moment, Moments } from '@/pages/catalog'
import { Settings } from '@/pages/Settings'

// the rail's sections, each with the colour its icon takes with the highlight (kivz.dev's palette: pink, blue, the
// mascot's yellow, green)
const NAV = [
  { id: 'home', href: '/', label: 'Home', Icon: HomeIcon, tint: 'var(--pink)' },
  { id: 'moments', href: '/moments', label: 'Moments', Icon: MomentsIcon, tint: 'var(--blue)' },
  { id: 'expressions', href: '/expressions', label: 'Expressions', Icon: PhrasesIcon, tint: 'var(--mascot)' },
  { id: 'settings', href: '/settings', label: 'Settings', Icon: SettingsIcon, tint: 'var(--green)' },
] as const
const tint = (c: string) => ({ '--tint': c }) as CSSProperties

function routeOf(path: string) {
  let m
  const arg = (x: string) => { try { return decodeURIComponent(x) } catch { return x } }
  if (path === '/') return { name: 'home', section: 'home' } as const
  if (path === '/moments') return { name: 'moments', section: 'moments' } as const
  if ((m = path.match(/^\/m\/([a-f0-9]{12})$/))) return { name: 'moment', section: 'moments', id: m[1] } as const
  if ((m = path.match(/^\/c\/(.+)$/))) return { name: 'category', section: 'home', arg: arg(m[1]) } as const
  if ((m = path.match(/^\/ch\/([a-z0-9_]+)$/))) return { name: 'channel', section: 'home', arg: m[1] } as const
  if (path === '/expressions') return { name: 'expressions', section: 'expressions' } as const
  if ((m = path.match(/^\/e\/(.+)$/))) return { name: 'expression', section: 'expressions', arg: arg(m[1]) } as const
  if (path === '/settings') return { name: 'settings', section: 'settings' } as const
  return { name: 'missing', section: null } as const
}
type Route = ReturnType<typeof routeOf>

const TITLES: Record<Route['name'], string> = {
  home: 'Earmark', moments: 'Moments', moment: 'A moment', category: 'Category', channel: 'Channel',
  expressions: 'Expressions', expression: 'Expression', settings: 'Settings', missing: 'Not found',
}

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
    const named = route.name === 'moment' ? library?.moments.find(m => m.id === route.id)?.title
      : route.name === 'category' || route.name === 'expression' ? route.arg
      : route.name === 'channel' ? library?.channels.find(c => c.login === route.arg)?.displayName : null
    document.title = locked || route.name === 'home' ? 'Earmark' : `${named || TITLES[route.name]} — Earmark`
  }, [shown, locked, library])

  const page =
    error && !meta ? <Down key="down" error={error} />
    : locked ? <Login key="login" setup={!!meta?.setup} />
    : route.name === 'home' ? <Home key={shown} />
    : route.name === 'moments' ? <Moments key={shown} />
    : route.name === 'moment' ? <Moment key={shown} id={route.id} />
    : route.name === 'category' ? <Category key={shown} name={route.arg} />
    : route.name === 'channel' ? <Channel key={shown} login={route.arg} />
    : route.name === 'expressions' ? <Expressions key={shown} />
    : route.name === 'expression' ? <Expression key={shown} name={route.arg} />
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
