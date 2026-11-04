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
    if (m.t === 'hello') return reply(settingsMessage())
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
          if (status === 200) { reply({ t: 'caught', sid: m.sid, n: data.caught }); badge(tabId, data.caught) }
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

async function pair() {
  const waiting = await pending()
  let id = waiting?.id
  if (!id) {
    try {
      const { status, data } = await api('/v1/pair', { method: 'POST', json: {} })
      if (status !== 200) return { ok: false, error: data?.error || `helper answered ${status}` }
      id = data.id
    } catch {
      return { ok: false, error: 'offline' }
    }
    await chrome.storage.local.set({ pairing: { id, until: Date.now() + 9 * 60 * 1000 } })
  }
  await chrome.tabs.create({ url: `${HELPER}/settings?pair=${encodeURIComponent(id)}` })
  // keep asking while this worker is awake (an extension call each round keeps it from sleeping mid-wait)
  ;(async () => {
    for (let i = 0; i < 120 && (await pending()); i++) {
      await new Promise(r => setTimeout(r, 1500))
      await collect()
    }
  })()
  return { ok: true, waiting: true }
}

// woken up with a pairing still open: see whether it was allowed while asleep
loaded.then(collect)
