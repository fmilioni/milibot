import { createHash } from 'node:crypto'

import { toBase64 } from './http/base64'

/**
 * Requests are built with images as `milibot-blob:<sha256>` placeholders. That form is what gets
 * logged in `llm_calls`; `inlineBlobs` swaps in the base64 bytes right before sending.
 */
const BLOB_PREFIX = 'milibot-blob:'
const BLOB_PATTERN = /milibot-blob:([0-9a-f]{64})/g

export interface BlobReader {
  read(sha256: string): Promise<Uint8Array>
}

export function blobRef(sha256: string): string {
  return BLOB_PREFIX + sha256
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function collectRefs(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(BLOB_PATTERN)) out.add(match[1] as string)
  } else if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, out)
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectRefs(item, out)
  }
}

function replaceRefs(value: unknown, encoded: Map<string, string>): unknown {
  if (typeof value === 'string') {
    return value.includes(BLOB_PREFIX)
      ? value.replace(BLOB_PATTERN, (_, sha: string) => encoded.get(sha) ?? '')
      : value
  }
  if (Array.isArray(value)) return value.map((item) => replaceRefs(item, encoded))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = replaceRefs(item, encoded)
    return out
  }
  return value
}

export async function inlineBlobs<T>(value: T, blobs: BlobReader): Promise<T> {
  const refs = new Set<string>()
  collectRefs(value, refs)
  if (refs.size === 0) return value
  const encoded = new Map<string, string>()
  for (const sha of refs) encoded.set(sha, toBase64(await blobs.read(sha)))
  return replaceRefs(value, encoded) as T
}

export class MemoryBlobStore implements BlobReader {
  private readonly data = new Map<string, Uint8Array>()

  add(bytes: Uint8Array): string {
    const sha = sha256Hex(bytes)
    this.data.set(sha, bytes)
    return sha
  }

  async put(bytes: Uint8Array): Promise<string> {
    return this.add(bytes)
  }

  async read(sha256: string): Promise<Uint8Array> {
    const bytes = this.data.get(sha256)
    if (!bytes) throw new Error(`blob not found: ${sha256}`)
    return bytes
  }
}
