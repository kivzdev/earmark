import { useMemo, useRef, useState } from 'react'
import { Link } from '@/router'
import {
  ago, count, dayKey, GROUP_NAME, GROUPS, length, nameOf, shortDay, slug, timeOf, todayKey, useStore,
  useTwitch, view, write, type ChannelLive, type Group, type LiveStream, type Seen,
} from '@/data'
import { CategoryCard, ChannelCard, LiveRow, MomentCard } from '@/ui/cards'
import { Head, Rows, Section, Table, Waiting } from '@/ui/bits'
import { MomentPlayer } from '@/ui/MomentPlayer'
import { usePill } from '@/ui/pill'
import { OutIcon } from '@/ui/icons'

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

/** live badges for a set of channels, from Twitch (through the helper or the online copy) */
function useLiveChannels(logins: string[]) {
  const key = [...logins].sort().slice(0, 50).join(',')
  return useTwitch<{ channels: Record<string, ChannelLive> }>(key ? `/api/twitch/channels?logins=${key}` : null, 120_000)?.channels ?? {}
}

// ── home: the catalog ─────────────────────────────────────────────────────────────────────────────────────────────
export function Home() {
  const { library, meta } = useStore()
  const v = library && view(library)
  if (!library || !v) return <Waiting title="Earmark" />
  const today = todayKey()
  const watchedToday = sum(library.sessions.filter(s => dayKey(s.startedAt) === today).map(s => s.heard))
  const keptToday = v.kept.filter(m => dayKey(m.at) === today).length
  const listening = (meta?.live || []).filter(l => !l.error)
  const lead = listening.length
    ? `Listening to ${listening.map(l => v.channels.find(c => c.login === l.channel)?.displayName || l.channel).join(' and ')} right now`
    : watchedToday ? `Today: ${length(watchedToday)} watched, ${count(keptToday, 'moment')} kept`
    : 'Everyday English from the streams you watch'
  return (
    <div className="page wide">
      <Head title="Earmark" lead={lead} />
      {meta?.mode === 'local' && meta.judge && !meta.judge.model && (
        <p className="muted" data-in="col">Moments are picked by the phrase list for now. Put an Anthropic API key in .env as ANTHROPIC_API_KEY and Claude picks them.</p>
      )}
      {v.categories.length === 0 ? (
        <p className="muted" data-in="col">Watch an English stream on Twitch and it shows up here, sorted into categories, with the moments worth keeping.</p>
      ) : (
        <>
          <Section label="Categories" end={v.categories.length > 12 ? <span className="muted">{count(v.categories.length, 'category', 'categories')}</span> : null}>
            <div className="covers">{v.categories.slice(0, 12).map(c => <CategoryCard key={c.name} c={c} />)}</div>
          </Section>
          <Section label="Kept for you" end={v.kept.length > 6 ? <Link className="u muted" href="/moments">All {v.kept.length}</Link> : null}>
            {v.kept.length ? (
              <div className="mgrid">{v.kept.slice(0, 6).map(m => <MomentCard key={m.id} m={m} />)}</div>
            ) : (
              <p className="muted" data-in="col">Nothing kept yet. Earmark keeps a moment once it has heard a minute of it.</p>
            )}
          </Section>
        </>
      )}
    </div>
  )
}

// ── one category: who's live there now, your moments, the channels you watch in it ───────────────────────────────
export function Category({ name }: { name: string }) {
  const { library } = useStore()
  const v = library && view(library)
  const c = v?.categories.find(x => x.name === name)
  const streams = useTwitch<{ streams: LiveStream[] }>(`/api/twitch/live?category=${slug(name)}`, 90_000)?.streams
  const chans = v ? v.channels.filter(ch => ch.categories.includes(name)) : []
  const live = useLiveChannels(chans.map(ch => ch.login))
  if (!library || !v) return <Waiting title={name} />
  return (
    <div className="page wide">
      <header className="cat-head" data-in="col">
        {c?.boxArt && <span className="art small"><img src={c.boxArt} alt="" /></span>}
        <span className="hello">
          <h1>{name}</h1>
          <p className="muted">{c ? `${length(c.watched)} watched · ${count(c.kept.length, 'moment')} kept` : 'Not watched yet'}{c && c.group !== 'gaming' ? ` · ${GROUP_NAME[c.group]}` : ''}</p>
        </span>
      </header>
      {c && c.kept.length > 0 && (
        <Section label="Kept for you">
          <div className="mgrid">{c.kept.map(m => <MomentCard key={m.id} m={m} />)}</div>
        </Section>
      )}
      {chans.length > 0 && (
        <Section label="Channels you watch here">
          <ul className="chans">{chans.map(ch => <ChannelCard key={ch.login} c={ch} live={live[ch.login]} />)}</ul>
        </Section>
      )}
      <Section label="Live on Twitch now" end={<a className="u muted" href={`https://www.twitch.tv/directory/category/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`} target="_blank" rel="noreferrer">More on Twitch</a>}>
        {streams === undefined ? <p className="muted" data-in="col">Asking Twitch…</p>
          : streams.length ? <ul className="years live-list"><li className="year" data-in="col"><span className="y muted">English</span><ul className="items">{streams.map(s => <LiveRow key={s.login} s={s} />)}</ul></li></ul>
          : <p className="muted" data-in="col">Nobody streaming in English right now.</p>}
      </Section>
    </div>
  )
}

// ── one channel ──────────────────────────────────────────────────────────────────────────────────────────────────
function CountsAs({ login, group }: { login: string; group: Group | null }) {
  const ref = useRef<HTMLDivElement>(null)
  const choices: (Group | null)[] = [null, ...GROUPS]
  usePill(ref, choices.indexOf(group))
  const set = (g: Group | null) => write('PATCH', `/api/channels/${login}`, { group: g }).catch(() => {})
  return (
    <div className="pills pills-x" ref={ref} role="group" aria-label="Counts as" data-in="col">
      <span className="pill" aria-hidden />
      {choices.map(g => (
        <button key={g ?? 'auto'} className="btn" type="button" data-pill aria-pressed={group === g} onClick={() => set(g)}>{g ? GROUP_NAME[g] : 'Auto'}</button>
      ))}
    </div>
  )
}

export function Channel({ login }: { login: string }) {
  const { library, meta } = useStore()
  const live = useLiveChannels([login])[login]
  const v = library && view(library)
  if (!library || !v) return <Waiting title={login} />
  const c = v.channels.find(x => x.login === login)
  if (!c) return <Missing />
  const now = live?.live
  const avatar = live?.avatar || c.avatar
  const latest = c.sessions[c.sessions.length - 1]
  return (
    <div className="page wide">
      <header className="chan-head" data-in="col">
        <span className="avatar big" data-live={now ? '' : undefined}>{avatar ? <img src={avatar} alt="" /> : null}</span>
        <span className="hello">
          <h1>{c.displayName}</h1>
          <p className="muted">
            {now ? `Live now · ${now.category ?? ''}` : live?.lastLive ? `Last live ${ago(live.lastLive)}` : `Watched ${ago(c.last)}`}
            {` · ${length(c.watched)} watched`}
          </p>
        </span>
        <span className="controls">
          {now ? <a className="btn btn-solo" href={`https://www.twitch.tv/${login}`} target="_blank" rel="noreferrer"><OutIcon /><span>Watch live</span></a>
            : live?.lastVod ? <a className="btn btn-solo" href={`https://www.twitch.tv/videos/${live.lastVod}`} target="_blank" rel="noreferrer"><OutIcon /><span>Last stream</span></a> : null}
        </span>
      </header>
      {c.kept.length > 0 ? (
        <Section label={`Kept from ${c.displayName}`}>
          <div className="mgrid">{c.kept.map(m => <MomentCard key={m.id} m={m} showChannel={false} />)}</div>
        </Section>
      ) : <p className="muted" data-in="col">Nothing kept from {c.displayName} yet.</p>}
      {meta?.mode === 'local' && latest && (
        <Section label="Counts as"><CountsAs login={login} group={library.channels.find(x => x.login === login)?.group ?? null} /></Section>
      )}
      <Section label="Watched">
        <Table>
          {[...new Set(c.sessions.map(s => dayKey(s.startedAt)))].reverse().slice(0, 20).map(d => (
            <Rows key={d} label={shortDay(c.sessions.find(s => dayKey(s.startedAt) === d)!.startedAt)}>
              {c.sessions.filter(s => dayKey(s.startedAt) === d).reverse().map(s => (
                <li key={s.id}><span className="row">
                  <span className="row-title">{s.title || s.category || 'Untitled'}</span>
                  <span className="muted">{timeOf(s.startedAt)} · {length(s.heard)}</span>
                </span></li>
              ))}
            </Rows>
          ))}
        </Table>
      </Section>
    </div>
  )
}

// ── all moments, sorted by kind of stream ────────────────────────────────────────────────────────────────────────
type Filter = { group: Group | null; game: string | null }

function Filters({ moments, filter, set }: { moments: Seen[]; filter: Filter; set: (f: Filter) => void }) {
  const groups = useRef<HTMLDivElement>(null)
  const gamesRef = useRef<HTMLDivElement>(null)
  const games = [...new Set(moments.filter(m => m.session.group === 'gaming' && m.session.game).map(m => m.session.game!))].sort()
  const options: (Group | null)[] = [null, ...GROUPS]
  usePill(groups, options.indexOf(filter.group))
  usePill(gamesRef, filter.group === 'gaming' ? [null, ...games].indexOf(filter.game) : -1)
  return (
    <div className="filters" data-in="col">
      <div className="pills pills-x" ref={groups} role="group" aria-label="Kind of stream">
        <span className="pill" aria-hidden />
        {options.map(g => (
          <button key={g ?? 'all'} className="btn" type="button" data-pill aria-pressed={filter.group === g}
            onClick={() => set({ group: g, game: null })}>{g ? GROUP_NAME[g] : 'All'}</button>
        ))}
      </div>
      <div className="pills pills-row" ref={gamesRef} role="group" aria-label="Game" hidden={filter.group !== 'gaming' || games.length < 2}>
        <span className="pill" aria-hidden />
        {[null, ...games].map(g => (
          <button key={g ?? 'all'} className="btn" type="button" data-pill aria-pressed={filter.game === g}
            onClick={() => set({ group: 'gaming', game: g })}>{g ?? 'All games'}</button>
        ))}
      </div>
    </div>
  )
}

export function Moments() {
  const { library, meta } = useStore()
  const [filter, setFilter] = useState<Filter>({ group: null, game: null })
  const [everything, setEverything] = useState(false)
  if (!library) return <Waiting title="Moments" />
  const v = view(library)
  const pool = everything ? v.moments : v.kept
  const shown = pool.filter(m => (!filter.group || m.session.group === filter.group) && (!filter.game || m.session.game === filter.game))
  return (
    <div className="page wide">
      <Head title="Moments" lead={everything ? 'Every minute Earmark heard' : 'The minutes worth hearing again: kept by Earmark, or saved by you'} />
      <div className="bar" data-in="col">
        <Filters moments={pool} filter={filter} set={setFilter} />
        {meta?.mode === 'local' && (
          <button className="btn btn-solo" type="button" data-on={everything || undefined} onClick={() => setEverything(e => !e)}>
            {everything ? 'Every minute' : 'Kept only'}
          </button>
        )}
      </div>
      {shown.length ? <div className="mgrid">{shown.slice(0, 120).map(m => <MomentCard key={m.id} m={m} />)}</div>
        : <p className="muted" data-in="col">Nothing here yet.</p>}
    </div>
  )
}

// ── one moment ───────────────────────────────────────────────────────────────────────────────────────────────────
export function Moment({ id }: { id: string }) {
  const { library } = useStore()
  const start = useMemo(() => { const s = new URLSearchParams(location.search).get('s'); return s ? Number(s) : undefined }, [id])
  if (!library) return <Waiting title="Moment" />
  const v = view(library)
  const m = v.moments.find(x => x.id === id)
  if (!m) return <Missing />
  // the channel's other moments, for next / previous
  const siblings = (m.kept ? v.kept : v.moments).filter(x => x.session.channel === m.session.channel)
  const i = siblings.findIndex(x => x.id === m.id)
  const newer = siblings[i - 1], older = siblings[i + 1]
  const keys = [...new Map(m.expressions.map(e => [e.key.toLowerCase(), e])).values()]
  return (
    <div className="page wide">
      <Head title={nameOf(m)} lead={<>
        <Link className="u" href={`/ch/${m.session.channel}`}>{m.session.displayName}</Link>
        {m.session.category && <> · <Link className="u" href={`/c/${slug(m.session.category)}`}>{m.session.category}</Link></>}
        {` · ${shortDay(m.at)}, ${timeOf(m.at)}`}
      </>} />
      <MomentPlayer key={m.id} m={m} start={start} side={
        <aside className="moment-side">
          {keys.length > 0 && (
            <Section label="Worth learning">
              <ul className="said-list">
                {keys.map(e => (
                  <li key={e.key} data-in="col">
                    <Link href={`/e/${slug(e.key)}`} className="said-key">{e.key}</Link>
                    {e.note && <span className="muted">{e.note}</span>}
                    {e.text.toLowerCase() !== e.key.toLowerCase() && <span className="muted">“{e.text}”</span>}
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <div className="controls" data-in="col">
            {newer && <Link className="btn btn-solo" href={`/m/${newer.id}`}><span>Newer</span></Link>}
            {older && <Link className="btn btn-solo" href={`/m/${older.id}`}><span>Older</span></Link>}
          </div>
        </aside>
      } />
    </div>
  )
}

// ── expressions: everything worth learning that was said, and who said it ────────────────────────────────────────
export function Expressions() {
  const { library } = useStore()
  if (!library) return <Waiting title="Expressions" />
  const v = view(library)
  return (
    <div className="page">
      <Head title="Expressions" lead={v.expressions.length ? `${count(v.expressions.length, 'expression')} heard, most heard first` : 'What’s worth learning in the moments, as Earmark finds it'} />
      {v.expressions.length ? (
        <section className="block">
          <Table>
            <Rows label="Heard">
              {v.expressions.map(x => (
                <li key={x.key}>
                  <Link className="row" href={`/e/${slug(x.key)}`}>
                    <span className="row-title">{x.key}</span>
                    <span className="muted">{x.uses.length} · {count(x.voices.size, 'voice')}</span>
                  </Link>
                </li>
              ))}
            </Rows>
          </Table>
        </section>
      ) : <p className="muted" data-in="col">Nothing yet.</p>}
    </div>
  )
}

export function Expression({ name }: { name: string }) {
  const { library } = useStore()
  if (!library) return <Waiting title={name} />
  const x = view(library).expressions.find(e => e.key.toLowerCase() === name.toLowerCase())
  if (!x) return <Missing />
  const byVoice = new Map<string, typeof x.uses>()
  for (const u of x.uses) {
    const k = u.m.session.displayName
    if (!byVoice.has(k)) byVoice.set(k, [])
    byVoice.get(k)!.push(u)
  }
  return (
    <div className="page">
      <Head title={x.key} lead={x.note || undefined} />
      <section className="block">
        <Table>
          {[...byVoice].map(([voice, uses]) => (
            <Rows key={voice} label={voice}>
              {uses.map(({ m, e }) => {
                const s = m.sentences[e.s]?.text ?? e.text
                return (
                  <li key={m.id + e.s + e.a}>
                    <Link className="row" href={`/m/${m.id}?s=${e.s}`}>
                      <span className="row-title said"><span className="muted">{s.slice(0, e.a)}</span>{s.slice(e.a, e.b)}<span className="muted">{s.slice(e.b)}</span></span>
                      <span className="muted">{shortDay(m.at)}</span>
                    </Link>
                  </li>
                )
              })}
            </Rows>
          ))}
        </Table>
      </section>
    </div>
  )
}

export function Missing() {
  return (
    <div className="page">
      <Head title="Not here" lead="There’s nothing at this address." />
      <p data-in="col"><Link className="u" href="/">Back home</Link></p>
    </div>
  )
}

