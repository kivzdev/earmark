// The toolbar popup: is Earmark running, what is it hearing on this tab, what did it just catch.
const $ = id => document.getElementById(id)
const README = 'https://github.com/kivzdev/earmark#readme'

const REASONS = {
  listening: 'Listening',
  ad: 'Waiting out an ad',
  paused: 'Paused',
  'not-paired': 'Not connected',
  'not-a-stream': 'Open a Twitch stream',
  'offline-channel': 'This channel is offline',
  'not-playing': 'Waiting for the stream to play',
  'not-english': 'Not an English stream',
  offline: 'Earmark isn’t running',
  restarting: 'Reconnecting…',
  retrying: 'Reconnecting…',
  loading: 'Loading…',
  starting: 'Starting…',
  'no-audio': 'This player has no sound',
  'recorder-error': 'Couldn’t record this player',
}
const GROUPS = { politics: 'Politics', entertainment: 'Entertainment', gaming: 'Gaming' }

/** set a line's text the site's way: the old words blur out where they stand, the new ones blur in in their place */
function swap(el, value) {
  if (el.textContent === value) return
  if (!el.textContent || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = value; return }
  el.classList.remove('in')
  el.classList.add('out')
  setTimeout(() => {
    el.textContent = value
    el.classList.remove('out')
    el.classList.add('in')
  }, 200)
}

const ask = m => new Promise(resolve => chrome.runtime.sendMessage(m, r => resolve(chrome.runtime.lastError ? null : r)))

async function tabState() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return null
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tab.id, { t: 'state' }, r => resolve(chrome.runtime.lastError ? null : r))
  })
}

function momentItem(r) {
  // a moment: its title once the judge has read it (its first words until then), and the expressions in it
  const li = document.createElement('li')
  const sub = Object.assign(document.createElement('span'), { className: 'sub', textContent: r.picked ? 'Kept for you' : r.title ? 'Moment' : 'Just heard' })
  const line = Object.assign(document.createElement('span'), { className: 'line', textContent: r.title || `“${r.first}”` })
  li.append(sub, line)
  if (r.expressions?.length) li.append(Object.assign(document.createElement('span'), { className: 'sub', textContent: r.expressions.join(' · ') }))
  return li
}

async function render() {
  const [status, tab] = await Promise.all([ask({ t: 'status' }), tabState()])
  const note = $('note')
  note.hidden = true
  $('connect').hidden = true

  if (!status?.helper) {
    swap($('state'), 'Not running')
    note.hidden = false
    note.innerHTML = ''
    note.append('Start Earmark on this computer: run ', Object.assign(document.createElement('code'), { textContent: 'earmark' }), ' in a terminal. ')
    note.append(Object.assign(document.createElement('a'), { href: README, target: '_blank', rel: 'noreferrer', textContent: 'Setup' }))
    $('pause').hidden = true
    $('tab').hidden = $('heard').hidden = true
    return
  }
  if (!status.paired) {
    swap($('state'), 'Not connected')
    $('connect').hidden = false
    note.hidden = false
    note.textContent = status.waiting
      ? 'Allow it in the Earmark tab that opened. This turns to Listening once you have.'
      : 'One step left: connect the extension to Earmark on this computer.'
    $('pause').hidden = true
    $('tab').hidden = $('heard').hidden = true
    return
  }

  const engine = status.status?.engine
  if (engine && !engine.ready) {
    note.hidden = false
    note.textContent = engine.error ? `The speech model didn’t load: ${engine.error}` : 'Loading the speech model…'
  }

  const reason = status.paused ? 'paused' : tab?.reason || 'not-a-stream'
  swap($('state'), REASONS[reason] || reason)
  $('pause').hidden = false
  swap($('pause'), status.paused ? 'Resume listening' : 'Pause listening')

  const live = (status.status?.sessions || []).find(s => s.id === tab?.sid)
  if (tab?.meta?.channel) {
    $('tab').hidden = false
    swap($('who'), tab.meta.displayName || tab.meta.channel)
    const group = live?.group ? GROUPS[live.group] : null
    const what = [tab.meta.category, group && group !== 'Gaming' ? group : null].filter(Boolean).join(' · ')
    swap($('what'), what || ' ')
  } else {
    $('tab').hidden = true
  }

  const recent = live?.recent || []
  $('heard').hidden = !live
  if (live) {
    swap($('count'), live.moments ? `${live.moments} ${live.moments === 1 ? 'moment' : 'moments'} so far` : 'The first moment comes after a minute')
    const list = $('recent')
    const key = recent.map(r => r.id + (r.title || '') + r.picked).join()
    if (list.dataset.key !== key) {
      list.dataset.key = key
      list.replaceChildren(...recent.slice(0, 3).map(momentItem))
    }
  }
  if (status.status?.site) $('open').href = status.status.site
  if (status.status?.judge?.error) {
    note.hidden = false
    note.textContent = `Picking moments by rules: ${status.status.judge.error}`
  }
}

$('pause').addEventListener('click', async () => {
  const status = await ask({ t: 'status' })
  await ask({ t: 'pause', paused: !status?.paused })
  render()
})

$('connect').addEventListener('click', async () => {
  const r = await ask({ t: 'pair' })
  const note = $('note')
  note.hidden = false
  note.textContent = r?.ok ? 'Allow it in the Earmark tab that just opened.' : `Couldn’t reach Earmark (${r?.error || 'offline'}).`
})

render()
setInterval(render, 1500)
