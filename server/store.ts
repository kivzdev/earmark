// Where the cloud copy keeps its files: a private Vercel Blob store on Vercel, or a folder (EARMARK_CLOUD_DIR) when
// the app runs anywhere else — your own server, or on your computer while you work on it.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { del, get, issueSignedToken, parseStoreIdFromDelegationToken, presignUrl, put, type IssuedSignedToken } from '@vercel/blob'

export interface Store {
  read(path: string, fresh?: boolean): Promise<Uint8Array<ArrayBuffer> | null>
  write(path: string, bytes: Uint8Array, type: string): Promise<void>
  remove(path: string): Promise<void>
  /** a link that reads the file straight from storage for a few hours (byte ranges and all), if the storage has them */
  link?(path: string): Promise<string>
  /** an upload straight to storage, for one file larger than a request to this app may carry */
  ticket?(path: string, type: string, size: number): Promise<{ url: string; headers: Record<string, string> }>
}

// Signed links come from a delegation the Blob API issues for up to a week, kept while the function lives and renewed
// a day before it runs out; the links themselves are signed here, without a call.
const HOUR = 3600_000
const DAY = 24 * HOUR
const delegations = new Map<'get' | 'put', { token: IssuedSignedToken; until: number }>()
async function delegation(op: 'get' | 'put') {
  const hit = delegations.get(op)
  if (hit && hit.until - Date.now() > DAY) return hit
  const until = Date.now() + 7 * DAY - HOUR
  const fresh = { token: await issueSignedToken({ pathname: '*', operations: [op], validUntil: until }), until }
  delegations.set(op, fresh)
  return fresh
}
// (a signed upload is a plain PUT: it carries the headers @vercel/blob 2.8's own put() sends with one)
const BLOB_API_VERSION = '13'

const blob: Store = {
  async read(path, fresh = false) {
    const got = await get(path, { access: 'private', useCache: !fresh })
    if (!got || got.statusCode !== 200) return null
    return new Uint8Array(await new Response(got.stream).arrayBuffer())
  },
  async write(path, bytes, type) {
    await put(path, Buffer.from(bytes), { access: 'private', contentType: type, allowOverwrite: true, addRandomSuffix: false })
  },
  async remove(path) {
    await del(path)
  },
  async link(path) {
    const { token, until } = await delegation('get')
    // (good for two to three hours, so a paused video can go on later; on the hour, so for an hour it's the same link
    // and the browser's cache keeps what it has)
    const validUntil = Math.min(until, Math.ceil((Date.now() + 2 * HOUR) / HOUR) * HOUR)
    return (await presignUrl(token, { operation: 'get', pathname: path, access: 'private', validUntil })).presignedUrl
  },
  async ticket(path, type, size) {
    const { token } = await delegation('put')
    const { presignedUrl } = await presignUrl(token, {
      operation: 'put', pathname: path, access: 'private', validUntil: Date.now() + HOUR / 4,
      allowedContentTypes: [type], maximumSizeInBytes: size, allowOverwrite: true, addRandomSuffix: false,
    })
    return {
      url: presignedUrl,
      headers: {
        // (the link only takes the type it was signed for, from Content-Type)
        'content-type': type,
        'x-api-version': BLOB_API_VERSION,
        'x-vercel-blob-store-id': parseStoreIdFromDelegationToken(token.delegationToken),
        'x-vercel-blob-access': 'private',
        'x-content-type': type,
        'x-add-random-suffix': '0',
        'x-allow-overwrite': '1',
      },
    }
  },
}

function folder(root: string): Store {
  const base = resolve(root)
  const at = (path: string) => {
    const full = resolve(join(base, path))
    if (!full.startsWith(base + sep)) throw new Error('bad path')
    return full
  }
  return {
    async read(path) {
      try { return new Uint8Array(await readFile(at(path))) } catch { return null }
    },
    async write(path, bytes) {
      await mkdir(dirname(at(path)), { recursive: true })
      await writeFile(at(path), bytes)
    },
    async remove(path) {
      await rm(at(path), { force: true })
    },
  }
}

export function store(): Store {
  if (process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN) return blob
  if (process.env.EARMARK_CLOUD_DIR) return folder(process.env.EARMARK_CLOUD_DIR)
  throw new Error('no storage: connect a private Vercel Blob store, or set EARMARK_CLOUD_DIR')
}
