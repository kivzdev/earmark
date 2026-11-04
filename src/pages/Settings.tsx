import { useState, type FormEvent } from 'react'
import { count, length, timeOf, useStore, write } from '@/data'
import { Head, Rows, Section, Table, Waiting } from '@/ui/bits'
import { PlusIcon, RemoveIcon } from '@/ui/icons'

/** Earmark on this computer: the extension asking to connect, the speech engine, the cloud copy, your own phrases */
export function Settings() {
  const { meta, library } = useStore()
  const [phrase, setPhrase] = useState('')
  const [error, setError] = useState('')
  if (!meta || !library) return <Waiting title="Settings" />
  const asked = new URLSearchParams(location.search).get('pair')
  const pairing = meta.pairing ?? []
  const engine = meta.engine
  const custom = meta.phrases ?? []

  const answer = (id: string, allow: boolean) => write('POST', `/api/pairing/${id}`, { allow })
    .then(() => { if (allow) window.postMessage({ source: 'earmark-dashboard', type: 'paired' }, location.origin) })
    .catch(e => setError(e.message))
  const add = async (e: FormEvent) => {
    e.preventDefault()
    if (!phrase.trim()) return
    try {
      await write('POST', '/api/patterns', { phrase })
      setPhrase('')
      setError('')
    } catch (err) {
      setError((err as Error).message)
    }
  }
  const remove = (id: string) => write('DELETE', `/api/patterns/${id}`).catch(e => setError(e.message))

  return (
    <div className="page">
      <Head title="Settings" lead="Earmark on this computer" />

      {pairing.length > 0 && <Section label="Extension">
        {pairing.map(p => (
          <div key={p.id} className="ask" data-in="col">
            <p>{p.id === asked ? 'The Earmark extension you just clicked wants to connect.' : 'A browser extension wants to connect.'}</p>
            <div className="controls">
              <button className="btn btn-solo" type="button" onClick={() => answer(p.id, true)}>Allow</button>
              <button className="btn btn-solo" type="button" onClick={() => answer(p.id, false)}>Deny</button>
            </div>
          </div>
        ))}
      </Section>}
      {asked && !pairing.length && <p className="muted" data-in="col">Connected. You can close this tab.</p>}

      <Section label="Picking moments">
        <Table>
          <Rows label="Judge">
            <li><span className="row"><span>{meta.judge?.model ? 'Claude Haiku 5.5' : 'The phrase list'}</span>
              <span className="muted">{meta.judge?.waiting ? `${meta.judge.waiting} waiting` : 'Up to date'}</span></span></li>
          </Rows>
        </Table>
        {!meta.judge?.model && <p className="muted" data-in="col">Add ANTHROPIC_API_KEY to the .env file next to the helper and restart it: Claude then picks the moments and the expressions in them (about a cent or two an hour of stream).</p>}
        {meta.judge?.error && <p className="muted" data-in="col">{meta.judge.error}</p>}
      </Section>

      <Section label="Speech">
        <Table>
          <Rows label="Engine">
            <li><span className="row"><span>{engine?.name}</span><span className="muted">{engine?.ready ? 'Ready' : engine?.error ? 'Didn’t load' : 'Loading…'}</span></span></li>
          </Rows>
          {(meta.live ?? []).map(l => (
            <Rows key={l.id} label="Listening">
              <li><span className="row"><span>{l.channel}</span><span className="muted">{length(l.heard)} · {count(l.moments, 'moment')}</span></span></li>
            </Rows>
          ))}
          <Rows label="At login">
            <li><span className="row"><span>{meta.autostart ? 'Starts by itself' : 'Off'}</span>
              <span className="muted">{meta.autostart ? 'earmark autostart off' : 'earmark autostart on'}</span></span></li>
          </Rows>
        </Table>
        {engine?.error && <p className="muted" data-in="col">{engine.error}</p>}
      </Section>

      <Section label="Cloud copy">
        {meta.sync ? (
          <Table>
            <Rows label="Address"><li><span className="row"><span className="row-title">{meta.sync.url}</span></span></li></Rows>
            <Rows label="Today"><li><span className="row"><span>{meta.sync.uploadedToday} of {meta.sync.perDay} clips uploaded</span></span></li></Rows>
            <Rows label="Last copy">
              <li><span className="row"><span>{meta.sync.lastOk ? timeOf(meta.sync.lastOk) : 'Not yet'}</span><span className="muted">{meta.sync.error ?? ''}</span></span></li>
            </Rows>
          </Table>
        ) : (
          <p className="muted" data-in="col">Off. Everything stays on this computer. To keep a private copy online, see the README.</p>
        )}
      </Section>

      <Section label="Your phrases (for the phrase list)">
        <form className="add" onSubmit={add} data-in="col">
          <input className="field" value={phrase} onChange={e => setPhrase(e.target.value)} placeholder="end up …ing" aria-label="A phrase to listen for" maxLength={120} />
          <button className="btn btn-solo" type="submit"><PlusIcon /><span>Add</span></button>
        </form>
        {error && <p className="muted" data-in="col">{error}</p>}
        {custom.length > 0 && (
          <Table>
            <Rows label="Added">
              {custom.map(p => (
                <li key={p.id}>
                  <span className="row">
                    <span className="row-title">{p.label}</span>
                    <button className="btn btn-solo btn-icon" type="button" onClick={() => remove(p.id)} aria-label={`Stop listening for ${p.label}`}><RemoveIcon /></button>
                  </span>
                </li>
              ))}
            </Rows>
          </Table>
        )}
        <p className="muted" data-in="col">Plain words, with … where anything can go. Earmark listens for them from now on.</p>
      </Section>

      {meta.home && (
        <Section label="Data">
          <p className="muted path" data-in="col">{meta.home}</p>
        </Section>
      )}
    </div>
  )
}
