import { useEffect, useState, useSyncExternalStore } from 'react'

// The library as the helper (or the online copy) serves it, and what the pages derive from it.

export type Group = 'politics' | 'entertainment' | 'gaming'
export const GROUPS: Group[] = ['politics', 'entertainment', 'gaming']
export const GROUP_NAME: Record<Group, string> = { politics: 'Politics', entertainment: 'Entertainment', gaming: 'Gaming' }

export type Session = {
  id: string; channel: string; displayName: string; category: string | null; group: Group; game: string | null
  title: string | null; kind: 'live' | 'vod'; vodId: string | null; startedAt: number; endedAt: number | null
  heard: number; words: number
}
export type Word = [string, number, number]
export type Sentence = { t0: number; t1: number; text: string; words: Word[] }
export type Expression = { key: string; text: string; note: string; s: number; a: number; b: number }
export type Moment = {
  id: string; sessionId: string; at: number; duration: number; title: string | null; score: number | null
  picked: boolean; starred: boolean; judged: number
  // the clip (720p, or what the stream was below that; clipH says), its 360p copy, a full-size and a small picture
  clip: string | null; low: string | null; clipH: number | null; poster: string | null; thumb: string | null
  vod: string | null; sentences: Sentence[]; expressions: Expression[]
}
export type Channel = { login: string; displayName: string; group: Group | null; avatar: string | null }
export type Category = { name: string; boxArt: string | null }
export type Library = {
  version: number; generatedAt: number; sessions: Session[]; moments: Moment[]; channels: Channel[]; categories: Category[]
}
export type Live = { id: string; channel: string; group: Group; game: string | null; heard: number; words: number; moments: number; error: string | null }
export type Meta = {
  mode: 'local' | 'cloud'
  version: string
  // local
  engine?: { name: string; ready: boolean; error: string | null }
  judge?: { model: string | null; error: string | null; waiting: number }
  sync?: { url: string; uploadedToday: number; perDay: number; lastOk: number; error: string | null } | null
  pairing?: { id: string; origin: string; created: number }[]
  live?: Live[]
  home?: string
  autostart?: boolean
  phrases?: { id: string; label: string }[]
  // cloud
  authed?: boolean
  setup?: boolean
}

type State = { meta: Meta | null; library: Library | null; error: string | null }
let state: State = { meta: null, library: null, error: null }
const subs = new Set<() => void>()
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; subs.forEach(f => f()) }
export const useStore = () => useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f) } }, () => state)
export const store = () => state

async function get<T>(url: string): Promise<{ status: number; data: T | null }> {
  const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' })
  let data: T | null = null
  try { data = await res.json() } catch { /* an empty or non-JSON answer */ }
  return { status: res.status, data }
}

let lastLive = ''
export async function loadMeta() {
  try {
    const { status, data } = await get<Meta>('/api/meta')
    if (status !== 200 || !data) throw new Error(`the server answered ${status}`)
    const live = JSON.stringify((data.live || []).map(l => [l.id, l.moments]))
    const changed = live !== lastLive
    lastLive = live
    set({ meta: data, error: null })
    return { meta: data, changed }
  } catch (e) {
    set({ error: state.meta ? null : String((e as Error).message || e) })
    return { meta: state.meta, changed: false }
  }
}

const empty = (): Library => ({ version: 2, generatedAt: 0, sessions: [], moments: [], channels: [], categories: [] })

export async function loadLibrary() {
  const { status, data } = await get<Library>('/api/library')
  if (status === 401 && state.meta) return set({ meta: { ...state.meta, authed: false }, library: null })
  if (status === 404 && state.meta?.mode === 'cloud') return set({ library: empty() })
  if (status !== 200 || !data) return set({ error: `the library didn't load (${status})` })
  // a copy uploaded by an older helper has no moments yet
  set({ library: data.version >= 2 ? data : empty(), error: null })
}

let started = false
export function start() {
  if (started) return
  started = true
  loadMeta().then(({ meta }) => {
    if (!meta) return
    if (meta.mode === 'local' || meta.authed) loadLibrary()
    if (meta.mode === 'local') {
      // while a stream is being listened to, new moments come in: reload when the counts move
      let tick = 0
      setInterval(async () => {
        const { changed } = await loadMeta()
        tick++
        if (changed || tick % 8 === 0) loadLibrary()
      }, 4000)
    } else {
      let last = Date.now()
      addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && Date.now() - last > 60_000 && state.meta?.authed) {
          last = Date.now()
          loadLibrary()
        }
      })
    }
  })
}

export const signedIn = async () => {
  await loadMeta()
  await loadLibrary()
}

/** where a clip or picture is served from: the helper's media folder, or the online copy (behind the sign-in) */
export const media = (path: string) => (state.meta?.mode === 'cloud' ? `/api/media/${path}` : `/media/${path}`)
/** a moment's small picture: inside the library in the online copy, a file on this computer */
export const thumbOf = (m: Moment) => (m.thumb?.startsWith('data:') ? m.thumb : m.thumb ? media(m.thumb) : m.poster ? media(m.poster) : null)

/** a change from the dashboard (this computer only): the custom header is what lets the helper trust it */
export async function write(method: 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { 'X-Earmark': '1', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data: { error?: string } | null = null
  try { data = await res.json() } catch { /* no body */ }
  if (!res.ok) throw new Error(data?.error || `the helper answered ${res.status}`)
  loadLibrary()
  loadMeta()
  return data
}

// ── what the pages read ───────────────────────────────────────────────────────────────────────────────────────
export type Seen = Moment & { session: Session; kept: boolean }
export type CategoryStat = { name: string; boxArt: string | null; group: Group; watched: number; kept: Seen[]; channels: string[]; last: number }
export type ChannelStat = Channel & { watched: number; kept: Seen[]; all: Seen[]; last: number; categories: string[]; sessions: Session[] }
export type Said = { key: string; note: string; uses: { m: Seen; e: Expression }[]; voices: Set<string> }
export type View = {
  sessions: Map<string, Session>
  moments: Seen[] // newest first
  kept: Seen[]
  categories: CategoryStat[] // most watched first
  channels: ChannelStat[] // most watched first
  expressions: Said[] // most used first
}

const views = new WeakMap<Library, View>()
export function view(lib: Library): View {
  const cached = views.get(lib)
  if (cached) return cached
  // a channel's name as Twitch spells it (the helper fetches it), over whatever the page said when the stream began
  const names = new Map(lib.channels.map(c => [c.login, c.displayName]))
  const sessions = new Map(lib.sessions.map(s => [s.id, { ...s, displayName: names.get(s.channel) || s.displayName }]))
  const moments: Seen[] = []
  for (const m of lib.moments) {
    const session = sessions.get(m.sessionId)
    if (session) moments.push({ ...m, session, kept: m.picked || m.starred })
  }
  moments.sort((a, b) => b.at - a.at)
  const kept = moments.filter(m => m.kept)

  const arts = new Map(lib.categories.map(c => [c.name, c.boxArt]))
  const cats = new Map<string, CategoryStat>()
  const chans = new Map<string, ChannelStat>()
  for (const c of lib.channels) chans.set(c.login, { ...c, watched: 0, kept: [], all: [], last: 0, categories: [], sessions: [] })
  for (const s of sessions.values()) {
    if (s.category) {
      const c = cats.get(s.category) ?? { name: s.category, boxArt: arts.get(s.category) ?? null, group: s.group, watched: 0, kept: [], channels: [], last: 0 }
      c.watched += s.heard
      c.last = Math.max(c.last, s.startedAt)
      if (!c.channels.includes(s.channel)) c.channels.push(s.channel)
      cats.set(s.category, c)
    }
    const ch = chans.get(s.channel) ?? { login: s.channel, displayName: s.displayName, group: null, avatar: null, watched: 0, kept: [], all: [], last: 0, categories: [], sessions: [] }
    ch.watched += s.heard
    ch.last = Math.max(ch.last, s.startedAt)
    ch.sessions.push(s)
    if (s.category && !ch.categories.includes(s.category)) ch.categories.push(s.category)
    chans.set(s.channel, ch)
  }
  for (const m of moments) {
    chans.get(m.session.channel)?.all.push(m)
    if (!m.kept) continue
    chans.get(m.session.channel)?.kept.push(m)
    if (m.session.category) cats.get(m.session.category)?.kept.push(m)
  }

  const said = new Map<string, Said>()
  for (const m of moments) {
    for (const e of m.expressions) {
      const key = e.key.trim()
      const x = said.get(key.toLowerCase()) ?? { key, note: e.note, uses: [], voices: new Set<string>() }
      x.uses.push({ m, e })
      x.voices.add(m.session.channel)
      said.set(key.toLowerCase(), x)
    }
  }
  const v: View = {
    sessions,
    moments,
    kept,
    categories: [...cats.values()].sort((a, b) => b.watched - a.watched),
    channels: [...chans.values()].filter(c => c.sessions.length).sort((a, b) => b.watched - a.watched),
    expressions: [...said.values()].sort((a, b) => b.uses.length - a.uses.length || a.key.localeCompare(b.key)),
  }
  views.set(lib, v)
  return v
}

// ── Twitch, asked through the helper or the online copy (short-lived cache, shared by every page) ──────────────
export type LiveStream = { login: string; displayName: string; avatar: string; title: string; viewers: number; since: string; preview: string }
export type ChannelLive = {
  displayName: string; avatar: string | null; lastLive: string | null; lastVod: string | null
  live: { title: string; viewers: number; since: string; category: string | null } | null
}
const asked = new Map<string, { at: number; data: unknown; wait?: Promise<unknown> }>()
export function useTwitch<T>(url: string | null, ttl = 60_000): T | null {
  const [data, setData] = useState<T | null>(() => (url && (asked.get(url)?.data as T)) || null)
  useEffect(() => {
    if (!url) return
    let alive = true
    const hit = asked.get(url)
    if (hit?.data) setData(hit.data as T)
    if (hit && (hit.wait || Date.now() - hit.at < ttl)) {
      hit.wait?.then(d => { if (alive && d) setData(d as T) })
      return () => { alive = false }
    }
    const wait = fetch(url, { credentials: 'same-origin' }).then(r => (r.ok ? r.json() : null)).catch(() => null)
    asked.set(url, { at: Date.now(), data: hit?.data ?? null, wait })
    wait.then(d => {
      asked.set(url, { at: Date.now(), data: d ?? hit?.data ?? null })
      if (alive && d) setData(d as T)
    })
    return () => { alive = false }
  }, [url, ttl])
  return data
}

// ── words for numbers and dates (day before month, like kivz.dev) ─────────────────────────────────────────────
const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' })
const DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
const SHORT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })
export const timeOf = (t: number) => TIME.format(new Date(t * 1000))
export const dayName = (d: Date) => DAY.format(d)
export const shortDay = (t: number) => SHORT.format(new Date(t * 1000))
export const dayKey = (t: number) => {
  const d = new Date(t * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
export const todayKey = () => dayKey(Date.now() / 1000)

export function length(seconds: number) {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} s`
  const m = Math.round(seconds / 60)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${m % 60} min`
}
export const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`
export const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`
export const viewers = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : String(n))

/** "2 h ago", "3 days ago" */
export function ago(when: number | string | null) {
  if (!when) return ''
  const t = typeof when === 'string' ? Date.parse(when) / 1000 : when
  const s = Date.now() / 1000 - t
  if (s < 90) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  const d = Math.round(s / 86400)
  return d === 1 ? 'yesterday' : `${d} days ago`
}

/** a moment's name: its title once judged, its first words until then */
export const nameOf = (m: Moment) => m.title || (m.sentences[0]?.text.split(' ').slice(0, 8).join(' ') ?? 'A moment') + '…'
export const slug = (s: string) => encodeURIComponent(s)
