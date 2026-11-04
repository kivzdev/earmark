import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react'

// The site's router, all of it: the address bar's path is the state — links push a new one, back / forward pop one —
// and the shell (home/Shell.tsx) decides what a path shows and how the old page leaves.
const subs = new Set<() => void>()
const tell = () => subs.forEach(f => f())
addEventListener('popstate', tell)

/** the path as the site reads it: "/", "/blog", "/blog/some-post"… (a trailing slash dropped) */
export const pathNow = () => location.pathname.replace(/(.)\/+$/, '$1')

export const usePath = () => useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f) } }, pathNow)

export function navigate(to: string) {
  if (to === pathNow()) return
  history.pushState(null, '', to)
  tell()
}

/** an <a> that moves within the site without a reload; new-tab and modified clicks and outside links work as usual */
export function Link({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const go = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e)
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || !href.startsWith('/')) return
    e.preventDefault()
    navigate(href)
  }
  return <a href={href} onClick={go} {...rest} />
}
