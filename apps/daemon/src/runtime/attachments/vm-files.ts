import { posix } from 'node:path'

import { type BlobStore, pngSize } from '@milibot/agent'
import type { AttachmentImage } from '@milibot/shared'

import { DaemonError } from '../../errors'
import { imageMediaType, isThumbnailable, jpegSize } from '../files'
import { type GuestClient, GuestError } from '../vm'
import { MAX_MODEL_IMAGE_SIDE } from './limits'
import { numberedName } from './paths'

export function fileRemoved(): DaemonError {
  return new DaemonError('not_found', 'The file is no longer in the VM', { code: 'FILE_REMOVED' })
}

export function notAFile(): DaemonError {
  return new DaemonError('validation_failed', 'The path is not a file', { code: 'NOT_A_FILE' })
}

export function outsideWorkspace(): DaemonError {
  return new DaemonError('validation_failed', 'The path leads outside /workspace', {
    code: 'OUTSIDE_WORKSPACE',
  })
}

export function vmNotRunning(): DaemonError {
  return new DaemonError('conflict', 'The workspace VM is not running', { code: 'VM_NOT_RUNNING' })
}

/** The planned path, or "name (2).ext"… when a file with that name already exists in the VM (or in `taken`). */
export async function freePath(
  guest: GuestClient,
  planned: string,
  taken: (path: string) => boolean,
): Promise<string> {
  const exists = async (path: string) => {
    try {
      await guest.fsRead(path, { maxBytes: 1 })
      return true
    } catch (err) {
      if (err instanceof GuestError && err.code === 'path_not_found') return false
      if (err instanceof GuestError && (err.code === 'not_a_file' || err.status === 400)) return true
      throw err
    }
  }
  if (!(await exists(planned))) return planned
  const dir = posix.dirname(planned)
  const name = posix.basename(planned)
  for (let n = 2; ; n++) {
    const path = posix.join(dir, numberedName(name, n))
    if (!taken(path) && !(await exists(path))) return path
  }
}

/** A PNG/JPEG the models can take, stored in the blob store with its size; null for anything else. */
export async function storedImage(blobs: BlobStore, bytes: Uint8Array): Promise<AttachmentImage | null> {
  // The browser's type can be empty or wrong: the bytes decide.
  const mediaType = imageMediaType(bytes)
  if (!isThumbnailable(mediaType)) return null
  const dims = mediaType === 'image/png' ? pngSize(bytes) : jpegSize(bytes)
  if (!dims || !dims.width || !dims.height) return null
  if (dims.width > MAX_MODEL_IMAGE_SIDE || dims.height > MAX_MODEL_IMAGE_SIDE) return null
  const sha256 = await blobs.put(bytes, mediaType)
  return { sha256, mediaType, width: dims.width, height: dims.height }
}
