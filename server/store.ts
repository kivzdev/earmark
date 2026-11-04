// Where the cloud copy keeps its files: a private Vercel Blob store on Vercel, or a folder (EARMARK_CLOUD_DIR) when
// the app runs anywhere else — your own server, or on your computer while you work on it.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { del, get, put } from '@vercel/blob'

export interface Store {
  read(path: string, fresh?: boolean): Promise<Uint8Array<ArrayBuffer> | null>
  write(path: string, bytes: Uint8Array, type: string): Promise<void>
  remove(path: string): Promise<void>
}

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
