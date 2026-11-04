import { useSyncExternalStore } from 'react'

// The library as the helper (or the cloud copy) serves it, and what the pages derive from it.

export type Group = 'politics' | 'entertainment' | 'gaming'
export const GROUPS: Group[] = ['politics', 'entertainment', 'gaming']
export const GROUP_NAME: Record<Group, string> = { politics: 'Politics', entertainment: 'Entertainment', gaming: 'Gaming' }
export type Kind = 'connector' | 'frame' | 'marker' | 'verb' | 'expression'
export const KINDS: Kind[] = ['connector', 'frame', 'marker', 'verb', 'expression']
export const KIND_NAME: Record<Kind, string> = { connector: 'Connectors', frame: 'Frames', marker: 'Markers', verb: 'Verbs', expression: 'Expressions' }

export type Pattern = { id: string; label: string; kind: Kind; weight: number; note: string; example: string; custom: boolean }
export type Session = {
  id: string; channel: string; displayName: string; category: string | null; group: Group; game: string | null
  title: string | null; kind: 'live' | 'vod'; startedAt: number; endedAt: number | null; heard: number; words: number
}
export type Word = [string, number, number]
export type Catch = {
  id: string; sessionId: string; pattern: string; sentence: string; match: [number, number]; words: Word[] | null
  at: number; duration: number; clip: string | null; poster: string | null; starred: boolean; vod: string | null
}
export type Library = {
  version: number; generatedAt: number; patterns: Pattern[]; sessions: Session[]; catches: Catch[]
  channels: { login: string; displayName: string; group: Group | null }[]
}
export type Live = { id: string; channel: string; group: Group; game: string | null; heard: number; words: number; caught: number; error: string | null }
export type Meta = {
  mode: 'local' | 'cloud'
  version: string
  // local
  engine?: { name: string; ready: boolean; error: string | null }
  sync?: { url: string; uploadedToday: number; perDay: number; lastOk: number; error: string | null } | null
  pairing?: { id: string; origin: string; created: number }[]
  live?: Live[]
  home?: string
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
    const live = JSON.stringify((data.live || []).map(l => [l.id, l.caught]))
    const changed = live !== lastLive
    lastLive = live
    set({ meta: data, error: null })
    return { meta: data, changed }
  } catch (e) {
    set({ error: state.meta ? null : String((e as Error).message || e) })
    return { meta: state.meta, changed: false }
  }
}

export async function loadLibrary() {
  const { status, data } = await get<Library>('/api/library')
  if (status === 401 && state.meta) return set({ meta: { ...state.meta, authed: false }, library: null })
  if (status === 404 && state.meta?.mode === 'cloud') return set({ library: empty() })
  if (status !== 200 || !data) return set({ error: `the library didn't load (${status})` })
  set({ library: data, error: null })
}

const empty = (): Library => ({ version: 1, generatedAt: 0, patterns: [], sessions: [], catches: [], channels: [] })

let started = false
export function start() {
  if (started) return
  started = true
  loadMeta().then(({ meta }) => {
    if (!meta) return
    if (meta.mode === 'local' || meta.authed) loadLibrary()
    if (meta.mode === 'local') {
      // while a stream is being listened to, new phrases come in: reload when the counts move
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

/** where a clip or a poster is served from: the helper's media folder, or the cloud copy (behind the sign-in) */
export const media = (path: string) => (state.meta?.mode === 'cloud' ? `/api/media/${path}` : `/media/${path}`)

/** a change from the dashboard (local only): the custom header is what lets the helper trust it */
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
export type Heard = Catch & { session: Session; phrase: Pattern }
export type View = {
  sessions: Map<string, Session>
  patterns: Map<string, Pattern>
  heard: Heard[] // oldest first
  byPattern: Map<string, Heard[]>
  firstHeard: Map<string, number>
}

const views = new WeakMap<Library, View>()
export function view(lib: Library): View {
  const cached = views.get(lib)
  if (cached) return cached
  const sessions = new Map(lib.sessions.map(s => [s.id, s]))
  const patterns = new Map(lib.patterns.map(p => [p.id, p]))
  const heard: Heard[] = []
  const byPattern = new Map<string, Heard[]>()
  const firstHeard = new Map<string, number>()
  for (const c of lib.catches) {
    const session = sessions.get(c.sessionId), phrase = patterns.get(c.pattern)
    if (!session || !phrase) continue
    const h = { ...c, session, phrase }
    heard.push(h)
    if (!byPattern.has(c.pattern)) byPattern.set(c.pattern, [])
    byPattern.get(c.pattern)!.push(h)
    if (!firstHeard.has(c.pattern)) firstHeard.set(c.pattern, c.at)
  }
  const v = { sessions, patterns, heard, byPattern, firstHeard }
  views.set(lib, v)
  return v
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
export const dateOfKey = (key: string) => new Date(`${key}T12:00:00`)

export function length(seconds: number) {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} s`
  const m = Math.round(seconds / 60)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${m % 60} min`
}
export const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`

/** the part of a sentence that is the phrase, as [before, phrase, after] */
export function parts(c: Catch): [string, string, string] {
  const [a, b] = c.match
  return [c.sentence.slice(0, a), c.sentence.slice(a, b), c.sentence.slice(b)]
}
