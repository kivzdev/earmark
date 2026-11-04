import { useState, type FormEvent } from 'react'
import { createPasskey, signIn } from '@/auth'
import { Head } from '@/ui/bits'
import { PasskeyIcon } from '@/ui/icons'

/** the cloud copy, before you're in: a passkey (Face ID, Touch ID, a security key) and nothing else */
export function Login({ setup }: { setup: boolean }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const go = async (e?: FormEvent) => {
    e?.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      if (setup) await createPasskey(code.trim())
      else await signIn()
    } catch (err) {
      const name = (err as Error).name
      setError(name === 'NotAllowedError' ? 'Cancelled.' : (err as Error).message || 'That didn’t work.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="page">
      <Head title="Earmark" lead={setup ? 'Make a passkey so this page opens only for you.' : 'This page is private.'} />
      <form className="login" onSubmit={go} data-in="col">
        {setup && (
          <input className="field" value={code} onChange={e => setCode(e.target.value)} placeholder="Setup code"
            aria-label="Setup code" autoComplete="one-time-code" spellCheck={false} />
        )}
        <div className="controls">
          <button className="btn btn-solo" type="submit" disabled={busy || (setup && !code.trim())}>
            <PasskeyIcon /><span>{setup ? 'Create a passkey' : 'Sign in with a passkey'}</span>
          </button>
        </div>
      </form>
      {error && <p className="muted" data-in="col">{error}</p>}
    </div>
  )
}
