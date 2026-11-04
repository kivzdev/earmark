import { useRef } from 'react'
import { gsap, useGSAP, reduced } from '@/motion/gsap'
import { useStore, useTwitch, view, viewers, type ChannelLive, type ChannelStat } from '@/data'
import { usePill } from './pill'

/** where a channel's row takes you on Twitch: the stream if it's live, else its last one */
const twitchOf = (login: string, live?: ChannelLive) =>
  live?.live ? `https://www.twitch.tv/${login}`
  : live?.lastVod ? `https://www.twitch.tv/videos/${live.lastVod}`
  : `https://www.twitch.tv/${login}/videos`

function List({ channels, live }: { channels: ChannelStat[]; live: Record<string, ChannelLive> }) {
  const ref = useRef<HTMLDivElement>(null)
  usePill(ref, -1)
  // (rows come in after the page: they rise into place the rail's way, one after another)
  useGSAP(() => {
    const rows = ref.current!.querySelectorAll('.chan-btn')
    if (reduced()) return
    gsap.fromTo(rows, { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0, duration: 0.7, ease: 'settle', stagger: 0.03, clearProps: 'transform' })
  }, { scope: ref })
  return (
    <div className="pills chan-list" ref={ref} aria-label="Channels">
      <span className="pill" aria-hidden />
      {channels.map(c => {
        const l = live[c.login]
        const avatar = l?.avatar || c.avatar
        const status = l?.live ? `Live · ${viewers(l.live.viewers)} watching${l.live.category ? ` · ${l.live.category}` : ''}` : 'Last stream'
        return (
          <a key={c.login} className="btn chan-btn" href={twitchOf(c.login, l)} target="_blank" rel="noreferrer" data-pill
            data-live={l?.live ? '' : undefined} title={`${c.displayName} · ${status}`} aria-label={`${c.displayName}, ${status}`}>
            <span className="ava">{avatar ? <img src={avatar} alt="" loading="lazy" /> : null}</span>
            <span className="chan-label">{c.displayName}</span>
            {l?.live && <i className="dot" aria-hidden />}
          </a>
        )
      })}
    </div>
  )
}

/**
 * The channels you watch, in the rail above its sections, set like them (one control box, 14/20): a small round
 * picture, the name, and Twitch's red dot when live. Live ones come first; twelve show, the rest scroll in place. A
 * row opens the stream on Twitch, or its last one.
 */
export function ChannelRail() {
  const { library } = useStore()
  const v = library && view(library)
  const logins = v ? v.channels.slice(0, 50).map(c => c.login).sort() : []
  const live = useTwitch<{ channels: Record<string, ChannelLive> }>(logins.length ? `/api/twitch/channels?logins=${logins.join(',')}` : null, 120_000)?.channels ?? {}
  if (!v || !v.channels.length) return null
  const sorted = [...v.channels].sort((a, b) =>
    Number(!!live[b.login]?.live) - Number(!!live[a.login]?.live)
    || (live[b.login]?.live?.viewers ?? 0) - (live[a.login]?.live?.viewers ?? 0)
    || b.watched - a.watched)
  // (a new channel remounts the list, so the sliding highlight knows every row)
  return <List key={logins.join(',')} channels={sorted} live={live} />
}
