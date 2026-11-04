// Earmark on twitch.tv: while a stream plays, record what the player shows and says (a small 360p copy) and hand it,
// a second at a time, to the Earmark helper on this computer. Nothing leaves the machine: the background script
// only talks to 127.0.0.1.
(() => {
  const RESERVED = new Set([
    'directory', 'videos', 'settings', 'search', 'downloads', 'jobs', 'p', 'subscriptions', 'inventory', 'wallet',
    'drops', 'friends', 'messages', 'turbo', 'prime', 'popout', 'moderator', 'u', 'login', 'signup', 'store',
    'broadcast', 'creatorcamp', 'following', 'event', 'legal', 'privacy', 'team', 'bits', 'products', 'user',
    'annual-recap', 'clip', 'clips', 'embed', 'charity', 'giftcard', 'activate', 'security',
  ])
  // Twitch's language tags; a stream tagged with one of these and not with English is skipped (the model is English)
  const OTHER_LANGUAGES = new Set([
    'español', 'deutsch', 'français', 'português', 'italiano', 'русский', 'türkçe', 'polski', '日本語', '한국어',
    '中文', 'العربية', 'nederlands', 'svenska', 'čeština', 'magyar', 'română', 'suomi', 'dansk', 'norsk', 'ελληνικά',
    'українська', 'ไทย', 'tiếng việt', 'bahasa indonesia', 'filipino', 'हिन्दी', 'català', 'slovenčina', 'български',
  ])
  const MAX_H = 720 // the helper keeps 720p: what the clips play back at

  let port = null
  let settings = { paired: false, paused: false }
  let rec = null // the recording in progress
  let starting = 0 // when the start was asked for (0: not starting)
  let retryAt = 0
  let lastMetaSent = ''
  let reason = 'starting'

  // ── the page ───────────────────────────────────────────────────────────────────────────────────────────────
  function page() {
    let m = location.pathname.match(/^\/videos\/(\d+)/)
    if (m) return { kind: 'vod', vodId: m[1], key: 'vod:' + m[1] }
    m = location.pathname.match(/^\/([a-z0-9_]{2,25})\/?$/i)
    if (m && !RESERVED.has(m[1].toLowerCase())) return { kind: 'live', channel: m[1].toLowerCase(), key: 'live:' + m[1].toLowerCase() }
    return null
  }

  const $ = s => document.querySelector(s)
  const text = s => $(s)?.textContent?.trim() || ''

  function isLive() {
    return !!$('[data-a-target="animated-channel-viewers-count"], .live-indicator-container, .tw-channel-status-text-indicator')
  }

  function adPlaying() {
    // Twitch's own "Ad" label and countdown over the player, and only while they're shown. (Not "ax-overlay": that's
    // the player's everyday overlay, there on every stream.)
    for (const el of document.querySelectorAll('[data-a-target="video-ad-label"], [data-a-target="video-ad-countdown"], .video-ad-label')) {
      if (el.offsetWidth || el.offsetHeight) return true
    }
    return false
  }

  // what the page last showed for each stream: theatre mode and fullscreen take the title and category off the page
  const seen = new Map()

  function meta(p) {
    const displayName = text('h1.tw-title') || text('h1')
    let channel = p.channel
    if (!channel) {
      // a VOD: the channel's own link carries its login
      for (const a of document.querySelectorAll('a[href^="/"]')) {
        const m = a.getAttribute('href').match(/^\/([a-z0-9_]{2,25})\/?$/i)
        if (m && !RESERVED.has(m[1].toLowerCase()) && displayName && a.textContent.trim() === displayName) { channel = m[1].toLowerCase(); break }
      }
      if (!channel && /^[a-z0-9_]{2,25}$/i.test(displayName)) channel = displayName.toLowerCase()
    }
    const link = $('a[data-a-target="stream-game-link"]')
    const now = {
      channel,
      displayName,
      // the category as the page words it (in your language) and its address name, the same in every language
      category: link?.textContent?.trim() || '',
      categorySlug: (link?.getAttribute('href') || '').match(/\/directory\/(?:category|game)\/([^/?#]+)/)?.[1]?.toLowerCase() || '',
      title: text('[data-a-target="stream-title"]') || text('h2[data-a-target="stream-title"]'),
      tags: [...document.querySelectorAll('a[href^="/directory/all/tags/"]')].map(a => a.textContent.trim()).filter(Boolean).slice(0, 20),
      kind: p.kind,
      vodId: p.vodId,
    }
    const before = seen.get(p.key) || {}
    for (const k of ['channel', 'displayName', 'category', 'categorySlug', 'title']) if (!now[k] && before[k]) now[k] = before[k]
    if (!now.tags.length && before.tags) now.tags = before.tags
    seen.set(p.key, now)
    return now
  }

  function english(tags) {
    const lower = tags.map(t => t.toLowerCase())
    return lower.includes('english') || !lower.some(t => OTHER_LANGUAGES.has(t))
  }

  function mainVideo() {
    let best = null, area = -1
    for (const v of document.querySelectorAll('video')) {
      if (v.readyState < 2) continue
      const r = v.getBoundingClientRect()
      const a = r.width * r.height
      if (a > area) { best = v; area = a }
    }
    return best
  }

  // ── talking to the background script ────────────────────────────────────────────────────────────────────
  function connect() {
    if (port) return port
    port = chrome.runtime.connect({ name: 'earmark' })
    port.onMessage.addListener(onMessage)
    port.onDisconnect.addListener(() => { port = null })
    port.postMessage({ t: 'hello' })
    return port
  }
  const send = m => { try { connect().postMessage(m) } catch { port = null } }

  function onMessage(m) {
    if (m.t === 'settings') {
      settings = { paired: m.paired, paused: m.paused }
      tick()
    } else if (m.t === 'started') {
      starting = 0
      if (rec && rec.pending) { rec.sid = m.sid; rec.pending = false; flush(rec) }
    } else if (m.t === 'start-failed') {
      starting = 0
      reason = m.error || 'offline'
      stop(false)
      retryAt = Date.now() + 15000
    } else if (m.t === 'gone' || m.t === 'offline') {
      // the helper restarted or stopped: begin a fresh recording a little later
      if (rec && (!m.sid || m.sid === rec.sid)) {
        reason = m.t === 'offline' ? 'offline' : 'restarting'
        stop(false)
        retryAt = Date.now() + (m.t === 'offline' ? 15000 : 2000)
      }
    } else if (m.t === 'caught' && rec && m.sid === rec.sid) {
      rec.caught = m.n
    }
  }

  // ── recording ───────────────────────────────────────────────────────────────────────────────────────────────
  function b64(buf) {
    const bytes = new Uint8Array(buf)
    let s = ''
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    return btoa(s)
  }

  function flush(r) {
    while (r.sid && r.queue.length) send({ t: 'chunk', sid: r.sid, seq: ++r.seq, data: r.queue.shift() })
  }

  function begin(p, video) {
    const src = video.captureStream()
    const audio = src.getAudioTracks()[0]
    if (!audio) { src.getTracks().forEach(t => t.stop()); reason = 'no-audio'; return }
    // a copy of the picture at up to 720p (the browser doesn't encode the full 1080p60 stream), 16:9
    const H = Math.min(MAX_H, Math.max(360, Math.round((video.videoHeight || MAX_H) / 2) * 2))
    const W = Math.round((H * 16) / 9 / 2) * 2
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d', { alpha: false })
    const r = { key: p.key, video, src, sid: null, pending: true, seq: 0, queue: [], caught: 0, alive: true, meta: meta(p) }
    let last = 0
    const draw = now => {
      if (!r.alive) return
      if (now - last >= 30 && video.videoWidth) {
        last = now
        const s = Math.min(W / video.videoWidth, H / video.videoHeight)
        const w = video.videoWidth * s, h = video.videoHeight * s
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, W, H)
        ctx.drawImage(video, (W - w) / 2, (H - h) / 2, w, h)
      }
      video.requestVideoFrameCallback ? video.requestVideoFrameCallback(draw) : requestAnimationFrame(draw)
    }
    draw(performance.now())
    r.canvasTrack = canvas.captureStream(30).getVideoTracks()[0]
    const stream = new MediaStream([r.canvasTrack, audio])
    // H.264 first: on a Mac Chrome hands it to the hardware encoder, so 720p costs next to nothing
    const mimeType = ['video/webm;codecs=h264,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t))
    r.recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 3_000_000, audioBitsPerSecond: 128_000 })
    r.recorder.ondataavailable = async e => {
      if (!e.data.size) return
      r.queue.push(b64(await e.data.arrayBuffer()))
      flush(r)
      if (!r.alive && !r.queue.length && r.sid && !r.ended) { r.ended = true; send({ t: 'end', sid: r.sid }) }
    }
    r.recorder.onerror = () => { reason = 'recorder-error'; stop(true) }
    audio.addEventListener('ended', () => { if (rec === r) stop(true) })
    // the recording's own clock: seconds recorded so far (ads pause it), the helper's stream time
    r.started = performance.now()
    r.paused = 0
    r.pausedAt = 0
    r.clock = () => (performance.now() - r.started - r.paused - (r.pausedAt ? performance.now() - r.pausedAt : 0)) / 1000
    if (p.kind === 'vod') {
      r.meta.vodOffset = video.currentTime
      // a jump in the VOD carries on in the same recording; the helper notes where the player went, so its links
      // back into the VOD keep pointing at the right second
      r.onSeek = () => { if (rec === r && r.sid) send({ t: 'meta', sid: r.sid, meta: { vodMark: [r.clock(), video.currentTime] } }) }
      video.addEventListener('seeked', r.onSeek)
    }
    r.recorder.start(1000)
    rec = r
    starting = Date.now()
    lastMetaSent = JSON.stringify([r.meta.categorySlug || r.meta.category, r.meta.title])
    send({ t: 'start', meta: r.meta })
    reason = 'listening'
  }

  function stop(tellHelper) {
    const r = rec
    if (!r) return
    rec = null
    r.alive = false
    if (r.onSeek) r.video.removeEventListener('seeked', r.onSeek)
    try { if (r.recorder.state !== 'inactive') r.recorder.stop() } catch {}
    r.src.getTracks().forEach(t => t.stop())
    r.canvasTrack?.stop()
    if (!tellHelper) r.sid = null
    // the recorder hands over its last piece, then ondataavailable sends 'end'
    setTimeout(() => {
      if (tellHelper && r.sid && r.queue.length === 0 && !r.ended) { r.ended = true; send({ t: 'end', sid: r.sid }) }
    }, 1500)
  }

  let blips = 0
  const BLIPS = new Set(['not-playing', 'offline-channel', 'loading', 'not-a-stream'])

  // ── the loop ────────────────────────────────────────────────────────────────────────────────────────────────
  function tick() {
    const p = page()
    let video = p && mainVideo()
    // the recording keeps its own player while that's still on the page and playing (an ad player can be bigger)
    if (rec && p && rec.key === p.key && rec.video.isConnected && !rec.video.paused && rec.video.readyState >= 2) video = rec.video
    const m = p && meta(p)
    let why = null
    if (!settings.paired) why = 'not-paired'
    else if (settings.paused) why = 'paused'
    else if (!p) why = 'not-a-stream'
    // (only to start: theatre mode and fullscreen take the live badge off the page while the stream plays on)
    else if (p.kind === 'live' && !rec && !isLive()) why = 'offline-channel'
    else if (!video || video.paused) why = 'not-playing'
    else if (!m.channel) why = 'loading'
    else if (!english(m.tags)) why = 'not-english'
    else if (Date.now() < retryAt) why = reason === 'listening' ? 'retrying' : reason

    if (starting && Date.now() - starting > 10000) {
      // no answer from the background script: drop this try and start again shortly
      starting = 0
      stop(false)
      retryAt = Date.now() + 5000
    }
    if (rec && why && BLIPS.has(why) && rec.key === p?.key && ++blips < 3) return
    if (!why) blips = 0
    if (rec && (why || rec.key !== p.key || rec.video !== video)) stop(true)
    if (why) { reason = why; return }
    if (!rec && !starting) begin(p, video)
    if (!rec) return
    if (adPlaying()) {
      if (rec.recorder.state === 'recording') { rec.recorder.pause(); rec.pausedAt = performance.now() }
      reason = 'ad'
    } else {
      if (rec.recorder.state === 'paused') {
        rec.recorder.resume()
        if (rec.pausedAt) { rec.paused += performance.now() - rec.pausedAt; rec.pausedAt = 0 }
      }
      reason = 'listening'
      const now = JSON.stringify([m.categorySlug || m.category, m.title])
      if (rec.sid && now !== lastMetaSent) {
        lastMetaSent = now
        send({ t: 'meta', sid: rec.sid, meta: m })
      }
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.t !== 'state') return
    const p = page()
    reply({ reason, page: p, meta: p ? meta(p) : null, sid: rec?.sid || null, caught: rec?.caught || 0 })
  })

  connect()
  setInterval(tick, 2000)
  tick()
})()
