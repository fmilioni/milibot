import { existsSync, mkdirSync } from 'node:fs'
import { readFile, rename, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { BlobStore } from '@milibot/agent'
import { sha256Hex } from '@milibot/agent/llm'

import { notFound } from '../errors'

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'application/octet-stream': 'bin',
}
const MEDIA_TYPES = Object.fromEntries(Object.entries(EXTENSIONS).map(([type, ext]) => [ext, type]))

/** Content-addressed files under `<wsDir>/debug/blobs/<sha[0:2]>/<sha>.<ext>` (screenshots, payload images). */
export class FileBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private dir(sha: string): string {
    return join(this.root, sha.slice(0, 2))
  }

  async put(bytes: Uint8Array, mediaType: string): Promise<string> {
    const sha = sha256Hex(bytes)
    const ext = EXTENSIONS[mediaType] ?? 'bin'
    const dir = this.dir(sha)
    const file = join(dir, `${sha}.${ext}`)
    if (existsSync(file)) {
      // Debug retention removes blobs by age: a reused blob counts from its latest use.
      const now = new Date()
      await utimes(file, now, now).catch(() => undefined)
      return sha
    }
    mkdirSync(dir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, bytes)
    await rename(tmp, file)
    return sha
  }

  private locate(sha: string): { file: string; mediaType: string } {
    if (!/^[0-9a-f]{64}$/.test(sha)) throw notFound('blob', sha)
    for (const [ext, mediaType] of Object.entries(MEDIA_TYPES)) {
      const file = join(this.dir(sha), `${sha}.${ext}`)
      if (existsSync(file)) return { file, mediaType }
    }
    throw notFound('blob', sha)
  }

  async read(sha: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.locate(sha).file))
  }

  async get(sha: string): Promise<{ mediaType: string; bytes: Uint8Array }> {
    const { file, mediaType } = this.locate(sha)
    return { mediaType, bytes: new Uint8Array(await readFile(file)) }
  }
}
