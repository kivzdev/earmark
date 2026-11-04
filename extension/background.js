// Earmark's background script: the only part of the extension that talks to the Earmark helper, and it only ever
// talks to 127.0.0.1. It forwards each tab's recording in order, keeps the pairing token, and shows the tab's
// catch count on the toolbar button.
const HELPER = 'http://127.0.0.1:3276'
let settings = { token: null, paused: false }
const loaded = chrome.storage.local.get(['token', 'paused']).then(s => { settings = { token: s.token || null, paused: !!s.paused } })
const ports = new Set()
const chains = new Map() // session id → the promise its chunks are queued on

chrome.action.setBadgeBackgroundColor({ color: '#1D1D1D' })
chrome.action.setBadgeTextColor?.({ color: '#EAEAE9' })

async function api(path, { method = 'GET', json, body } = {}) {
  const headers = {}
  if (settings.token) headers['X-Earmark-Token'] = settings.token
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json) }
  else if (body) headers['Content-Type'] = 'application/octet-stream'
  const res = await fetch(HELPER + path, { method, headers, body, cache: 'no-store' })
  let data = null
  try { data = await res.json() } catch {}
  return { status: res.status, data }
}

const settingsMessage = () => ({ t: 'settings', paired: !!settings.token, paused: settings.paused })

function bytes(b64) {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

function badge(tabId, n) {
  if (tabId != null) chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {})
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'earmark' || !port.sender?.tab) return
  const tabId = port.sender.tab.id
  ports.add(port)
  port.onDisconnect.addListener(() => ports.delete(port))
  const reply = m => { try { port.postMessage(m) } catch {} }

  port.onMessage.addListener(async m => {
    await loaded
    if (m.t === 'hello') {
      if (!settings.token) await autoPair()
      return reply(settingsMessage())
    }
    if (!settings.token) return reply(settingsMessage())
    try {
      if (m.t === 'start') {
        const { status, data } = await api('/v1/sessions', { method: 'POST', json: m.meta })
        if (status === 200) { reply({ t: 'started', sid: data.id }); badge(tabId, 0) }
        else if (status === 401) await forget()
        else reply({ t: 'start-failed', error: data?.error || `helper answered ${status}` })
      } else if (m.t === 'chunk') {
        const prev = chains.get(m.sid) || Promise.resolve()
        const next = prev.then(async () => {
          const { status, data } = await api(`/v1/sessions/${m.sid}/chunk?seq=${m.seq}`, { method: 'POST', body: bytes(m.data) })
          if (status === 200) { reply({ t: 'caught', sid: m.sid, n: data.moments }); badge(tabId, data.moments) }
          else if (status === 401) await forget()
          else if (status === 410 || status === 404) { chains.delete(m.sid); reply({ t: 'gone', sid: m.sid }) }
        }).catch(() => { chains.delete(m.sid); reply({ t: 'offline', sid: m.sid }) })
        chains.set(m.sid, next)
      } else if (m.t === 'meta') {
        await api(`/v1/sessions/${m.sid}/meta`, { method: 'POST', json: m.meta })
      } else if (m.t === 'end') {
        const prev = chains.get(m.sid) || Promise.resolve()
        chains.delete(m.sid)
        await prev
        await api(`/v1/sessions/${m.sid}/end`, { method: 'POST', json: {} })
      }
    } catch {
      reply({ t: 'offline', sid: m.sid })
    }
  })
})

async function forget() {
  // the helper no longer knows this token (its data was reset): pair again
  await chrome.storage.local.remove('token')
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if ('token' in changes) settings.token = changes.token.newValue || null
  if ('paused' in changes) settings.paused = !!changes.paused.newValue
  for (const p of ports) { try { p.postMessage(settingsMessage()) } catch {} }
})

// ── the popup, and the dashboard's Allow ─────────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return
  // the dashboard page (dashboard.js) says you allowed the extension: collect the token now
  if (sender.tab) {
    if (m.t === 'paired' && /^http:\/\/(127\.0\.0\.1|localhost):3276\//.test(sender.url || '')) collect()
    return
  }
  ;(async () => {
    await loaded
    if (m.t === 'status') {
      await collect()
      if (!settings.token) await autoPair()
      try {
        const { status, data } = await api('/v1/status')
        reply({ helper: true, paired: status === 200, status: status === 200 ? data : null, paused: settings.paused, waiting: !!(await pending()) })
      } catch {
        reply({ helper: false, paired: !!settings.token, paused: settings.paused })
      }
    } else if (m.t === 'pause') {
      await chrome.storage.local.set({ paused: !!m.paused })
      reply({ ok: true })
    } else if (m.t === 'pair') {
      reply(await pair())
    }
  })()
  return true
})

// Pairing: the helper makes a request, you allow it on the dashboard, the helper hands the token over once. The request
// is kept in storage, so it's picked up even if Chrome put this worker to sleep meanwhile: when it wakes, whenever the
// popup asks, and the moment the dashboard says you allowed it.
async function pending() {
  const { pairing } = await chrome.storage.local.get('pairing')
  return pairing && pairing.until > Date.now() ? pairing : null
}

async function collect() {
  const p = await pending()
  if (!p) return
  try {
    const { data } = await api(`/v1/pair/${encodeURIComponent(p.id)}`)
    if (data?.state === 'allowed' && data.token) await chrome.storage.local.set({ token: data.token, pairing: null })
    else if (data?.state === 'denied' || data?.state === 'gone') await chrome.storage.local.remove('pairing')
  } catch { /* the helper isn't answering right now: try again later */ }
}

// Earmark on this computer lets its extension in by itself (unless it was set to ask first, EARMARK_AUTO_PAIR=0): ask
// for the token whenever there isn't one, at most twice a minute
let askedAt = 0
async function autoPair() {
  if (settings.token || Date.now() - askedAt < 30000) return
  askedAt = Date.now()
  await request()
}

/** ask the helper to pair; a request it allows at once is collected at once, one that waits is kept for later */
async function request() {
  try {
    const { status, data } = await api('/v1/pair', { method: 'POST', json: {} })
    if (status !== 200) return { ok: false, error: data?.error || `helper answered ${status}` }
    await chrome.storage.local.set({ pairing: { id: data.id, until: Date.now() + 9 * 60 * 1000 } })
    if (data.state === 'allowed') { await collect(); return { ok: true, paired: true } }
    return { ok: true, id: data.id }
  } catch {
    return { ok: false, error: 'offline' }
  }
}

async function pair() {
  const waiting = await pending()
  const r = waiting ? { ok: true, id: waiting.id } : await request()
  if (!r.ok || r.paired) return r
  // this helper wants you to allow it on its dashboard
  await chrome.tabs.create({ url: `${HELPER}/settings?pair=${encodeURIComponent(r.id)}` })
  ;(async () => {
    for (let i = 0; i < 120 && (await pending()); i++) {
      await new Promise(res => setTimeout(res, 1500))
      await collect()
    }
  })()
  return { ok: true, waiting: true }
}

// woken up with a pairing still open: see whether it was allowed while asleep
loaded.then(async () => { await collect(); await autoPair() })
