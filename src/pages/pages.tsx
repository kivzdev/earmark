import { useMemo, useRef, useState } from 'react'
import { Link } from '@/router'
import {
  count, dateOfKey, dayKey, dayName, GROUP_NAME, GROUPS, KIND_NAME, KINDS, length, shortDay, timeOf, todayKey, useStore,
  view, write, type Group, type Heard, type Session,
} from '@/data'
import { usePill } from '@/ui/pill'
import { Player } from '@/ui/Player'
import { bySentence, Head, Rows, Said, Section, Table, Waiting } from '@/ui/bits'

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

// ── today (or any day): what was watched, heard and caught ──────────────────────────────────────────────────
export function Today({ day }: { day?: string }) {
  const { library, meta } = useStore()
  const key = day ?? todayKey()
  const isToday = key === todayKey()
  if (!library) return <Waiting title={isToday ? 'Today' : dayName(dateOfKey(key))} />
  const v = view(library)
  const sessions = library.sessions.filter(s => dayKey(s.startedAt) === key)
  const heard = v.heard.filter(h => dayKey(h.at) === key)
  const watched = sum(sessions.map(s => s.heard))
  const streams = new Set(sessions.map(s => s.channel)).size
  const words = sum(sessions.map(s => s.words))
  const fresh = [...v.firstHeard.values()].filter(t => dayKey(t) === key).length
  const phrases = new Set(heard.map(h => h.pattern)).size
  const live = (meta?.live || []).filter(l => !l.error)

  // what you watched, by kind (games by name)
  const kinds = new Map<string, Session[]>()
  for (const s of sessions) {
    const label = s.group === 'gaming' ? s.game || 'Gaming' : GROUP_NAME[s.group]
    if (!kinds.has(label)) kinds.set(label, [])
    kinds.get(label)!.push(s)
  }
  // what you heard, by who said it (newest first)
  const voices = new Map<string, Heard[]>()
  for (const h of [...heard].reverse()) {
    if (!voices.has(h.session.displayName)) voices.set(h.session.displayName, [])
    voices.get(h.session.displayName)!.push(h)
  }
  // the days before, newest first
  const days = [...new Set(library.sessions.map(s => dayKey(s.startedAt)))].filter(d => d !== key).sort().reverse().slice(0, 14)

  return (
    <div className="page">
      <Head title={isToday ? 'Today' : dayName(dateOfKey(key))}
        lead={isToday ? (live.length ? `Listening to ${live.map(l => l.channel).join(' and ')} right now` : dayName(new Date())) : 'A day of listening'} />
      <section className="block">
        <Table>
          <Rows label="Watched"><li><span className="row"><span>{length(watched)}</span><span className="muted">{count(streams, 'stream')}</span></span></li></Rows>
          <Rows label="Heard"><li><span className="row"><span>{count(words, 'word')}</span></span></li></Rows>
          <Rows label="Caught"><li><span className="row"><span>{count(bySentence(heard).length, 'sentence')}</span><span className="muted">{count(phrases, 'phrase')}{fresh ? `, ${fresh} new` : ''}</span></span></li></Rows>
        </Table>
      </section>

      {sessions.length === 0 && (
        <p className="muted" data-in="col">
          {isToday ? 'Nothing yet today. Open a Twitch stream and Earmark will listen with you.' : 'Nothing was watched that day.'}
        </p>
      )}

      {kinds.size > 0 && (
        <Section label="Streams">
          <Table>
            {[...kinds].map(([label, list]) => (
              <Rows key={label} label={label}>
                {list.map(s => (
                  <li key={s.id}>
                    <Link className="row" href={`/streamers/${s.channel}`}>
                      <span className="row-title">{s.displayName}<span className="muted"> {timeOf(s.startedAt)}</span></span>
                      <span className="muted">{length(s.heard)}</span>
                    </Link>
                  </li>
                ))}
              </Rows>
            ))}
          </Table>
        </Section>
      )}

      {voices.size > 0 && (
        <Section label="Heard">
          <Table>
            {[...voices].map(([name, list]) => (
              <Rows key={name} label={name}>
                {bySentence(list).map(([h, ...also]) => (
                  <li key={h.id}>
                    <Link className="row" href={`/phrases/${h.pattern}?c=${h.id}`}>
                      <span className="row-title"><Said c={h} also={also} /></span>
                      <span className="muted">{timeOf(h.at)}</span>
                    </Link>
                  </li>
                ))}
              </Rows>
            ))}
          </Table>
        </Section>
      )}

      {days.length > 0 && (
        <Section label="Earlier">
          <Table>
            <Rows label={isToday ? 'Days' : <Link className="u" href="/">Today</Link>}>
              {days.map(d => {
                const ss = library.sessions.filter(s => dayKey(s.startedAt) === d)
                const n = v.heard.filter(h => dayKey(h.at) === d).length
                return (
                  <li key={d}>
                    <Link className="row" href={`/day/${d}`}>
                      <span className="row-title">{dayName(dateOfKey(d))}</span>
                      <span className="muted">{length(sum(ss.map(s => s.heard)))} · {count(n, 'sentence')}</span>
                    </Link>
                  </li>
                )
              })}
            </Rows>
          </Table>
        </Section>
      )}
    </div>
  )
}

// ── the filter: all, or one kind of stream (and one game) ──────────────────────────────────────────────────────
type Filter = { group: Group | null; game: string | null }
const matches = (s: Session, f: Filter) => (!f.group || s.group === f.group) && (!f.game || s.game === f.game)

function Filters({ sessions, filter, set }: { sessions: Session[]; filter: Filter; set: (f: Filter) => void }) {
  const groups = useRef<HTMLDivElement>(null)
  const gamesRef = useRef<HTMLDivElement>(null)
  const games = [...new Set(sessions.filter(s => s.group === 'gaming' && s.game).map(s => s.game!))].sort()
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

// ── phrases: everything heard, by kind of phrase ──────────────────────────────────────────────────────────────
export function Phrases() {
  const { library } = useStore()
  const [filter, setFilter] = useState<Filter>({ group: null, game: null })
  if (!library) return <Waiting title="Phrases" />
  const v = view(library)
  const heard = v.heard.filter(h => matches(h.session, filter))
  const byPattern = new Map<string, Heard[]>()
  for (const h of heard) {
    if (!byPattern.has(h.pattern)) byPattern.set(h.pattern, [])
    byPattern.get(h.pattern)!.push(h)
  }
  const voices = new Set(heard.map(h => h.session.channel)).size
  const waiting = library.patterns.length - byPattern.size
  return (
    <div className="page">
      <Head title="Phrases" lead={heard.length
        ? `${count(byPattern.size, 'phrase')} heard from ${count(voices, 'voice')}`
        : 'The everyday English Earmark listens for'} />
      <Filters sessions={library.sessions} filter={filter} set={setFilter} />
      {byPattern.size > 0 ? (
        <section className="block">
          <Table>
            {KINDS.map(kind => {
              const rows = library.patterns.filter(p => p.kind === kind && byPattern.has(p.id))
                .map(p => ({ p, hs: byPattern.get(p.id)! }))
                .sort((a, b) => b.hs.length - a.hs.length)
              if (!rows.length) return null
              return (
                <Rows key={kind} label={KIND_NAME[kind]}>
                  {rows.map(({ p, hs }) => (
                    <li key={p.id}>
                      <Link className="row" href={`/phrases/${p.id}`}>
                        <span className="row-title">{p.label}</span>
                        <span className="muted">{hs.length} · {count(new Set(hs.map(h => h.session.channel)).size, 'voice')}</span>
                      </Link>
                    </li>
                  ))}
                </Rows>
              )
            })}
          </Table>
        </section>
      ) : (
        <p className="muted" data-in="col">{library.catches.length ? 'Nothing heard in these streams yet.' : 'Nothing heard yet. Open a Twitch stream and Earmark will listen with you.'}</p>
      )}
      {waiting > 0 && (
        <Section label={`Still listening for ${waiting} more`}>
          <p className="muted listening" data-in="col">
            {library.patterns.filter(p => !byPattern.has(p.id)).map(p => p.label).join(' · ')}
          </p>
        </Section>
      )}
    </div>
  )
}

// ── one phrase: its clips, voice by voice ───────────────────────────────────────────────────────────────────
export function Phrase({ id }: { id: string }) {
  const { library } = useStore()
  const asked = new URLSearchParams(location.search).get('c')
  const [current, setCurrent] = useState<string | null>(asked)
  const v = library && view(library)
  const p = v?.patterns.get(id)
  const all = useMemo(() => (v?.byPattern.get(id) ?? []).slice().reverse(), [v, id])
  const clips = all.filter(h => h.clip)
  if (!library) return <Waiting title="Phrase" />
  if (!p) return <Missing />
  const pick = (cid: string) => {
    setCurrent(cid)
    history.replaceState(null, '', `/phrases/${id}?c=${cid}`)
  }
  const on = clips.find(h => h.id === current)?.id ?? clips[0]?.id
  const voices = new Map<string, Heard[]>()
  for (const h of all) {
    if (!voices.has(h.session.displayName)) voices.set(h.session.displayName, [])
    voices.get(h.session.displayName)!.push(h)
  }
  return (
    <div className="page">
      <Head title={p.label} lead={p.note} />
      {on ? <Player list={clips} current={on} onPick={pick} /> : null}
      {voices.size > 0 ? (
        <Section label={count(voices.size, 'voice')}>
          <Table>
            {[...voices].map(([name, list]) => (
              <Rows key={name} label={name}>
                {list.map(h => (
                  <li key={h.id} data-current={h.id === on || undefined}>
                    {h.clip ? (
                      <button className="row" type="button" onClick={() => pick(h.id)} aria-current={h.id === on || undefined}>
                        <span className="row-title"><Said c={h} /></span>
                        <span className="muted">{shortDay(h.at)}</span>
                      </button>
                    ) : (
                      <span className="row" title="No clip: the sentence only">
                        <span className="row-title"><Said c={h} /></span>
                        <span className="muted">{shortDay(h.at)}</span>
                      </span>
                    )}
                  </li>
                ))}
              </Rows>
            ))}
          </Table>
        </Section>
      ) : (
        <p className="muted" data-in="col">Not heard yet. For example: “{p.example}”</p>
      )}
    </div>
  )
}

// ── streams: who you watched, by kind ─────────────────────────────────────────────────────────────────────────
export function Streams() {
  const { library } = useStore()
  const [filter, setFilter] = useState<Filter>({ group: null, game: null })
  if (!library) return <Waiting title="Streams" />
  const v = view(library)
  const sessions = library.sessions.filter(s => matches(s, filter))
  type Row = { login: string; name: string; watched: number; caught: number; last: number }
  const kinds = new Map<string, Map<string, Row>>()
  for (const s of sessions) {
    const label = s.group === 'gaming' ? s.game || 'Gaming' : GROUP_NAME[s.group]
    if (!kinds.has(label)) kinds.set(label, new Map())
    const rows = kinds.get(label)!
    const r = rows.get(s.channel) ?? { login: s.channel, name: s.displayName, watched: 0, caught: 0, last: 0 }
    r.watched += s.heard
    r.caught += new Set(v.heard.filter(h => h.sessionId === s.id).map(h => h.sentence)).size
    r.last = Math.max(r.last, s.startedAt)
    rows.set(s.channel, r)
  }
  const order = [...kinds].sort((a, b) => {
    const rank = (l: string) => (l === 'Politics' ? 0 : l === 'Entertainment' ? 1 : 2)
    return rank(a[0]) - rank(b[0]) || sum([...b[1].values()].map(r => r.watched)) - sum([...a[1].values()].map(r => r.watched))
  })
  return (
    <div className="page">
      <Head title="Streams" lead={sessions.length
        ? `${length(sum(sessions.map(s => s.heard)))} watched across ${count(new Set(sessions.map(s => s.channel)).size, 'streamer')}`
        : 'What you watch, sorted into politics, entertainment and games'} />
      <Filters sessions={library.sessions} filter={filter} set={setFilter} />
      {order.length > 0 ? (
        <section className="block">
          <Table>
            {order.map(([label, rows]) => (
              <Rows key={label} label={label}>
                {[...rows.values()].sort((a, b) => b.watched - a.watched).map(r => (
                  <li key={r.login}>
                    <Link className="row" href={`/streamers/${r.login}`}>
                      <span className="row-title">{r.name}</span>
                      <span className="muted">{length(r.watched)} · {count(r.caught, 'sentence')}</span>
                    </Link>
                  </li>
                ))}
              </Rows>
            ))}
          </Table>
        </section>
      ) : (
        <p className="muted" data-in="col">Nothing watched yet.</p>
      )}
    </div>
  )
}

// ── one streamer: what they streamed, what they said ─────────────────────────────────────────────────────────
/** which kind a streamer counts as: worked out from each stream, or set by hand */
function CountsAs({ login, group }: { login: string; group: Group | null }) {
  const ref = useRef<HTMLDivElement>(null)
  const choices: (Group | null)[] = [null, ...GROUPS]
  usePill(ref, choices.indexOf(group))
  const set = (g: Group | null) => write('PATCH', `/api/channels/${login}`, { group: g }).catch(() => {})
  return (
    <div className="pills pills-x" ref={ref} role="group" aria-label="Counts as" data-in="col">
      <span className="pill" aria-hidden />
      {choices.map(g => (
        <button key={g ?? 'auto'} className="btn" type="button" data-pill aria-pressed={group === g}
          onClick={() => set(g)}>{g ? GROUP_NAME[g] : 'Auto'}</button>
      ))}
    </div>
  )
}

export function Streamer({ login }: { login: string }) {
  const { library, meta } = useStore()
  if (!library) return <Waiting title="Streamer" />
  const channel = library.channels.find(c => c.login === login)
  const v = view(library)
  const sessions = library.sessions.filter(s => s.channel === login).reverse()
  if (!sessions.length) return <Missing />
  const heard = v.heard.filter(h => h.session.channel === login).reverse()
  const name = sessions[0].displayName
  const latest = sessions[0]
  const byPhrase = new Map<string, Heard[]>()
  for (const h of heard) {
    if (!byPhrase.has(h.phrase.label)) byPhrase.set(h.phrase.label, [])
    byPhrase.get(h.phrase.label)!.push(h)
  }
  return (
    <div className="page">
      <Head title={name} lead={`${latest.group === 'gaming' ? latest.game || 'Gaming' : GROUP_NAME[latest.group]} · ${length(sum(sessions.map(s => s.heard)))} watched · ${count(heard.length, 'sentence')}`} />
      {meta?.mode === 'local' && (
        <Section label="Counts as">
          <CountsAs login={login} group={channel?.group ?? null} />
        </Section>
      )}
      {byPhrase.size > 0 && (
        <Section label="Said">
          <Table>
            {[...byPhrase].map(([label, list]) => (
              <Rows key={label} label={label}>
                {list.map(h => (
                  <li key={h.id}>
                    <Link className="row" href={`/phrases/${h.pattern}?c=${h.id}`}>
                      <span className="row-title"><Said c={h} /></span>
                      <span className="muted">{shortDay(h.at)}</span>
                    </Link>
                  </li>
                ))}
              </Rows>
            ))}
          </Table>
        </Section>
      )}
      <Section label="Watched">
        <Table>
          {[...new Set(sessions.map(s => dayKey(s.startedAt)))].map(d => (
            <Rows key={d} label={<Link className="u" href={`/day/${d}`}>{shortDay(dateOfKey(d).getTime() / 1000)}</Link>}>
              {sessions.filter(s => dayKey(s.startedAt) === d).map(s => (
                <li key={s.id}>
                  <span className="row">
                    <span className="row-title">{s.title || s.category || 'Untitled'}</span>
                    <span className="muted">{timeOf(s.startedAt)} · {length(s.heard)}</span>
                  </span>
                </li>
              ))}
            </Rows>
          ))}
        </Table>
      </Section>
    </div>
  )
}

export function Missing() {
  return (
    <div className="page">
      <Head title="Not here" lead="There’s nothing at this address." />
      <p data-in="col"><Link className="u" href="/">Back to today</Link></p>
    </div>
  )
}
