// The cloud copy's API (Vercel, or anywhere Node runs): your computer's helper uploads clips and a snapshot of the
// library with a sync token; the dashboard reads them back behind a passkey. Nothing here is public.
//
// Settings (environment):
//   EARMARK_ORIGIN       the address it's served at, e.g. https://earmark.kivz.dev (passkeys are bound to it)
//   SESSION_SECRET       32+ random characters; signs the sign-in cookie
//   EARMARK_SETUP_CODE   needed once, to make the first passkey
//   EARMARK_SYNC_TOKEN   what the helper sends with its uploads (same value in the helper's .env)
//   storage: a private Vercel Blob store connected to the project, or EARMARK_CLOUD_DIR
import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticatorTransportFuture,
} from '@simplewebauthn/server'
import { store } from './store.js'

const VERSION = '0.1.0'
const env = (k: string) => (process.env[k] ?? '').trim()
const origin = () => env('EARMARK_ORIGIN') || 'http://localhost:5191'
const rpID = () => new URL(origin()).hostname
const secure = () => origin().startsWith('https://')
const SESSION = () => (secure() ? '__Host-earmark' : 'earmark')
const CHALLENGE = () => (secure() ? '__Host-earmark-challenge' : 'earmark-challenge')
const DAY = 24 * 60 * 60 * 1000

const CLIP = /^clips\/\d{4}\/\d{2}\/[a-f0-9]{12}\.mp4$/
const LIBRARY = 'library.json.gz'
const PASSKEYS = 'auth/passkeys.json'

type Passkey = { id: string; publicKey: string; counter: number; transports?: AuthenticatorTransportFuture[]; created: number }

// ── small helpers ──────────────────────────────────────────────────────────────────────────────────────────────
function secret() {
  const s = env('SESSION_SECRET')
  if (s.length < 32) throw new Error('SESSION_SECRET is missing or shorter than 32 characters')
  return s
}
const mac = (body: string) => createHmac('sha256', secret()).update(body).digest('base64url')
const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
function seal(payload: object, ttl: number) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttl })).toString('base64url')
  return `${body}.${mac(body)}`
}
function open<T extends { exp: number }>(token: string | undefined): T | null {
  if (!token) return null
  const [body, sig] = token.split('.')
  if (!body || !sig || !same(sig, mac(body))) return null
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString()) as T
    return data.exp > Date.now() ? data : null
  } catch {
    return null
  }
}
const cookie = (c: Context, name: string, value: string, maxAge: number) =>
  setCookie(c, name, value, { path: '/', httpOnly: true, secure: secure(), sameSite: 'Strict', maxAge })

const authed = (c: Context) => {
  try { return !!open<{ exp: number; v: number }>(getCookie(c, SESSION())) } catch { return false }
}

async function passkeys(): Promise<Passkey[]> {
  const raw = await store().read(PASSKEYS, true)
  return raw ? (JSON.parse(Buffer.from(raw).toString()) as Passkey[]) : []
}
const savePasskeys = (list: Passkey[]) => store().write(PASSKEYS, Buffer.from(JSON.stringify(list)), 'application/json')

// a light brake on guessing the setup code: per address, 20 tries in 15 minutes (per running instance)
const tries = new Map<string, number[]>()
function slow(c: Context) {
  const ip = c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local'
  const now = Date.now()
  const list = (tries.get(ip) ?? []).filter(t => now - t < 15 * 60 * 1000)
  list.push(now)
  tries.set(ip, list)
  return list.length > 20
}

// ── the app ──────────────────────────────────────────────────────────────────────────────────────────────────
export const app = new Hono().basePath('/api')

app.onError((err, c) => {
  console.error(err)
  return c.json({ error: err.message.startsWith('SESSION_SECRET') || err.message.startsWith('no storage') ? err.message : 'something went wrong' }, 500)
})

app.use('*', async (c, next) => {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'no-referrer')
  if (!c.res.headers.get('Cache-Control')) c.header('Cache-Control', 'no-store')
})

// cookie-authenticated changes need a header other sites can't send without a preflight we never grant
app.use('/auth/*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.header('X-Earmark') !== '1') return c.json({ error: 'forbidden' }, 403)
  await next()
})

app.get('/meta', async c => {
  const signed = authed(c)
  return c.json({ mode: 'cloud', version: VERSION, authed: signed, setup: signed ? false : (await passkeys()).length === 0 })
})

// ── passkeys ──────────────────────────────────────────────────────────────────────────────────────────────────
app.post('/auth/register/options', async c => {
  const { code } = await c.req.json<{ code?: string }>().catch(() => ({ code: '' }))
  const list = await passkeys()
  if (!authed(c)) {
    // the first passkey (or a lost one) is made with the setup code; after that only from inside
    if (slow(c)) return c.json({ error: 'too many tries, wait a few minutes' }, 429)
    const setup = env('EARMARK_SETUP_CODE')
    if (setup.length < 12 || !code || !same(code, setup)) return c.json({ error: 'that setup code isn’t right' }, 401)
  }
  const options = await generateRegistrationOptions({
    rpName: 'Earmark',
    rpID: rpID(),
    userName: 'earmark',
    userID: new TextEncoder().encode('earmark-owner'),
    attestationType: 'none',
    excludeCredentials: list.map(p => ({ id: p.id, transports: p.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  })
  cookie(c, CHALLENGE(), seal({ challenge: options.challenge, kind: 'register' }, 5 * 60 * 1000), 300)
  return c.json(options)
})

app.post('/auth/register/verify', async c => {
  const chal = open<{ exp: number; challenge: string; kind: string }>(getCookie(c, CHALLENGE()))
  deleteCookie(c, CHALLENGE(), { path: '/', secure: secure() })
  if (!chal || chal.kind !== 'register') return c.json({ error: 'that took too long, try again' }, 400)
  const { response } = await c.req.json()
  const result = await verifyRegistrationResponse({
    response, expectedChallenge: chal.challenge, expectedOrigin: origin(), expectedRPID: rpID(),
  }).catch(() => null)
  if (!result?.verified) return c.json({ error: 'the passkey couldn’t be checked' }, 400)
  const { credential } = result.registrationInfo
  const list = await passkeys()
  list.push({
    id: credential.id, publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter, transports: credential.transports, created: Date.now(),
  })
  await savePasskeys(list)
  cookie(c, SESSION(), seal({ v: 1 }, 30 * DAY), 30 * DAY / 1000)
  return c.json({ ok: true })
})

app.post('/auth/login/options', async c => {
  const list = await passkeys()
  if (!list.length) return c.json({ error: 'no passkey yet: set one up first' }, 400)
  const options = await generateAuthenticationOptions({
    rpID: rpID(),
    allowCredentials: list.map(p => ({ id: p.id, transports: p.transports })),
    userVerification: 'preferred',
  })
  cookie(c, CHALLENGE(), seal({ challenge: options.challenge, kind: 'login', n: randomBytes(4).toString('hex') }, 5 * 60 * 1000), 300)
  return c.json(options)
})

app.post('/auth/login/verify', async c => {
  const chal = open<{ exp: number; challenge: string; kind: string }>(getCookie(c, CHALLENGE()))
  deleteCookie(c, CHALLENGE(), { path: '/', secure: secure() })
  if (!chal || chal.kind !== 'login') return c.json({ error: 'that took too long, try again' }, 400)
  const { response } = await c.req.json()
  const list = await passkeys()
  const key = list.find(p => p.id === response?.id)
  if (!key) return c.json({ error: 'that passkey isn’t one of this page’s' }, 401)
  const result = await verifyAuthenticationResponse({
    response, expectedChallenge: chal.challenge, expectedOrigin: origin(), expectedRPID: rpID(),
    credential: { id: key.id, publicKey: new Uint8Array(Buffer.from(key.publicKey, 'base64url')), counter: key.counter, transports: key.transports },
  }).catch(() => null)
  if (!result?.verified) return c.json({ error: 'the passkey couldn’t be checked' }, 401)
  key.counter = result.authenticationInfo.newCounter
  await savePasskeys(list)
  cookie(c, SESSION(), seal({ v: 1 }, 30 * DAY), 30 * DAY / 1000)
  return c.json({ ok: true })
})

app.post('/auth/logout', c => {
  deleteCookie(c, SESSION(), { path: '/', secure: secure() })
  return c.json({ ok: true })
})

// ── reading (signed in) ───────────────────────────────────────────────────────────────────────────────────────
app.get('/library', async c => {
  if (!authed(c)) return c.json({ error: 'sign in' }, 401)
  const raw = await store().read(LIBRARY, true)
  if (!raw) return c.json({ error: 'nothing uploaded yet' }, 404)
  return c.body(gunzipSync(raw).toString(), 200, { 'Content-Type': 'application/json; charset=utf-8' })
})

app.get('/media/*', async c => {
  if (!authed(c)) return c.json({ error: 'sign in' }, 401)
  const path = c.req.path.replace(/^\/api\/media\//, '')
  if (!CLIP.test(path)) return c.json({ error: 'not found' }, 404)
  const bytes = await store().read(path)
  if (!bytes) return c.json({ error: 'not found' }, 404)
  const size = bytes.length
  const head = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=31536000, immutable' }
  const m = (c.req.header('Range') || '').match(/^bytes=(\d*)-(\d*)$/)
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
    let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
    if (start > end || start >= size) return c.body(null, 416, { 'Content-Range': `bytes */${size}` })
    start = Math.max(0, start)
    end = Math.max(start, end)
    return c.body(bytes.slice(start, end + 1), 206, { ...head, 'Content-Range': `bytes ${start}-${end}/${size}` })
  }
  return c.body(bytes, 200, head)
})

// ── the helper's uploads (sync token) ─────────────────────────────────────────────────────────────────────────
app.use('/sync/*', async (c, next) => {
  const token = env('EARMARK_SYNC_TOKEN')
  const given = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '')
  if (token.length < 24 || !given || !same(given, token)) return c.json({ error: 'not allowed' }, 401)
  await next()
})

app.put('/sync/clip', async c => {
  const path = c.req.query('path') || ''
  if (!CLIP.test(path)) return c.json({ error: 'bad path' }, 400)
  const bytes = new Uint8Array(await c.req.arrayBuffer())
  if (bytes.length < 100 || bytes.length > 4 * 1024 * 1024) return c.json({ error: 'bad size' }, 413)
  // an MP4 starts with a box whose type is ftyp
  if (Buffer.from(bytes.slice(4, 8)).toString() !== 'ftyp') return c.json({ error: 'not an mp4' }, 415)
  await store().write(path, bytes, 'video/mp4')
  return c.json({ ok: true })
})

app.delete('/sync/clip', async c => {
  const path = c.req.query('path') || ''
  if (!CLIP.test(path)) return c.json({ error: 'bad path' }, 400)
  await store().remove(path)
  return c.json({ ok: true })
})

app.put('/sync/library', async c => {
  const bytes = new Uint8Array(await c.req.arrayBuffer())
  let data: { version?: number; catches?: unknown[] }
  try {
    data = JSON.parse(gunzipSync(bytes).toString())
  } catch {
    return c.json({ error: 'send the library as gzipped JSON' }, 400)
  }
  if (data.version !== 1 || !Array.isArray(data.catches)) return c.json({ error: 'not an Earmark library' }, 400)
  await store().write(LIBRARY, bytes, 'application/gzip')
  return c.json({ ok: true })
})
