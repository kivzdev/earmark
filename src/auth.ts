import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { signedIn } from '@/data'

// The cloud copy's sign-in: passkeys only. The first one needs the setup code from the deployment's settings;
// after that, signing in is the passkey alone.

async function post<T>(url: string, body: unknown = {}): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Earmark': '1' },
    body: JSON.stringify(body),
  })
  let data: (T & { error?: string }) | null = null
  try { data = await res.json() } catch { /* no body */ }
  if (!res.ok) throw new Error(data?.error || `the server answered ${res.status}`)
  return data as T
}

export async function createPasskey(code: string) {
  const options = await post<Parameters<typeof startRegistration>[0]['optionsJSON']>('/api/auth/register/options', { code })
  const response = await startRegistration({ optionsJSON: options })
  await post('/api/auth/register/verify', { response })
  await signedIn()
}

export async function signIn() {
  const options = await post<Parameters<typeof startAuthentication>[0]['optionsJSON']>('/api/auth/login/options')
  const response = await startAuthentication({ optionsJSON: options })
  await post('/api/auth/login/verify', { response })
  await signedIn()
}

export async function signOut() {
  await post('/api/auth/logout').catch(() => {})
  location.href = '/'
}
