import { Link } from '@/router'
import {
  ago, clock, count, GROUP_NAME, length, nameOf, slug, thumbOf, viewers,
  type CategoryStat, type ChannelLive, type ChannelStat, type LiveStream, type Seen,
} from '@/data'
import { OutIcon } from './icons'

// The catalog's pieces, Twitch-like but on kivz.dev's quiet surface: covers and pictures carry the colour, the words
// stay 14/20 white and grey, and hovering one dims the rest of its row (like the ruled tables).

/** a category: Twitch's vertical box art, its name, how long you watched it */
export function CategoryCard({ c }: { c: CategoryStat }) {
  return (
    <Link className="cover" href={`/c/${slug(c.name)}`} data-in="col">
      <span className="art">{c.boxArt ? <img src={c.boxArt} alt="" loading="lazy" /> : <span className="art-none">{c.name}</span>}</span>
      <span className="cover-text">
        <span className="cover-name">{c.name}</span>
        <span className="muted">{length(c.watched)}{c.kept.length ? ` · ${count(c.kept.length, 'moment')}` : ''}</span>
      </span>
    </Link>
  )
}

/** a channel: round picture, name, live now or when it last was, and the way to its last stream */
export function ChannelCard({ c, live }: { c: ChannelStat; live?: ChannelLive }) {
  const now = live?.live
  const status = now ? `Live · ${viewers(now.viewers)} watching${now.category ? ` · ${now.category}` : ''}`
    : live?.lastLive ? `Last live ${ago(live.lastLive)}` : `Watched ${ago(c.last)}`
  const avatar = live?.avatar || c.avatar
  return (
    <li className="chan" data-in="col">
      <Link className="chan-main" href={`/ch/${c.login}`}>
        <span className="avatar" data-live={now ? '' : undefined}>
          {avatar ? <img src={avatar} alt="" loading="lazy" /> : <span>{c.displayName.slice(0, 1)}</span>}
        </span>
        <span className="chan-text">
          <span className="chan-name">{c.displayName}</span>
          <span className="muted">{status}</span>
        </span>
      </Link>
      {now ? (
        <a className="btn btn-solo" href={`https://www.twitch.tv/${c.login}`} target="_blank" rel="noreferrer"><OutIcon /><span>Watch</span></a>
      ) : live?.lastVod ? (
        <a className="btn btn-solo" href={`https://www.twitch.tv/videos/${live.lastVod}`} target="_blank" rel="noreferrer"><OutIcon /><span>Last stream</span></a>
      ) : null}
    </li>
  )
}

/** a moment: its picture with its length, its title, who said it where, the expressions in it */
export function MomentCard({ m, showChannel = true }: { m: Seen; showChannel?: boolean }) {
  const thumb = thumbOf(m)
  const where = [showChannel ? m.session.displayName : null, m.session.category || GROUP_NAME[m.session.group], ago(m.at)]
  return (
    <Link className="mcard" href={`/m/${m.id}`} data-in="col">
      <span className="thumb">
        {thumb ? <img src={thumb} alt="" loading="lazy" /> : null}
        <span className="dur">{clock(m.duration)}</span>
        {m.starred && <span className="mark" aria-label="Saved">★</span>}
      </span>
      <span className="mtitle">{nameOf(m)}</span>
      <span className="muted">{where.filter(Boolean).join(' · ')}</span>
      {m.expressions.length > 0 && (
        <span className="chips">{[...new Set(m.expressions.map(e => e.key))].slice(0, 3).join(' · ')}</span>
      )}
    </Link>
  )
}

/** someone live on Twitch right now, in a category you watch */
export function LiveRow({ s }: { s: LiveStream }) {
  return (
    <li>
      <a className="row live-row" href={`https://www.twitch.tv/${s.login}`} target="_blank" rel="noreferrer">
        <span className="avatar small" data-live=""><img src={s.avatar} alt="" loading="lazy" /></span>
        <span className="row-title"><span>{s.displayName}</span> <span className="muted">{s.title}</span></span>
        <span className="muted">{viewers(s.viewers)}</span>
      </a>
    </li>
  )
}
