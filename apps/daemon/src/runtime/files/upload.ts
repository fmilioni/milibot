import { existsSync } from 'node:fs'
import { open, stat, truncate, writeFile } from 'node:fs/promises'

import type { UploadChunkBody } from '@milibot/shared'

import { DaemonError } from '../../errors'

/**
 * Writes a chunk of a chunked upload into its staging file. `received` is what was accepted so far: a chunk
 * may repeat (rewind) but not skip bytes. Returns the new `received`.
 */
export async function writeChunkAt(
  file: string,
  received: number,
  size: number,
  chunk: UploadChunkBody,
): Promise<number> {
  const bytes = Buffer.from(chunk.data, 'base64')
  if (chunk.offset > received)
    throw new DaemonError('validation_failed', `Expected offset ${received}`, { received })
  if (chunk.offset + bytes.length > size)
    throw new DaemonError('validation_failed', 'More bytes than the declared size')
  if (!existsSync(file)) await writeFile(file, new Uint8Array())
  if (chunk.offset < received) await truncate(file, chunk.offset)
  const handle = await open(file, 'r+')
  try {
    await handle.write(bytes, 0, bytes.length, chunk.offset)
  } finally {
    await handle.close()
  }
  return chunk.offset + bytes.length
}

/** Throws unless the staging file holds exactly the declared `size` (an empty upload gets an empty file). */
export async function assertUploadComplete(file: string, received: number, size: number): Promise<void> {
  if (size === 0 && !existsSync(file)) await writeFile(file, new Uint8Array())
  const actual = (await stat(file).catch(() => null))?.size ?? -1
  if (received !== size || actual !== size)
    throw new DaemonError('validation_failed', `Received ${Math.max(0, actual)} of ${size} bytes`)
}
