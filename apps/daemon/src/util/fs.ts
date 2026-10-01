import { existsSync, renameSync, rmSync, type WriteFileOptions, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

import { DaemonError } from '../errors'

/** `relative` in `start` or the nearest ancestor that has it. */
export function findUp(start: string, relative: string): string | null {
  let dir = start
  for (;;) {
    const candidate = join(dir, relative)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Writes through a temporary file in the same folder and renames it, so readers never see half a file. */
export function writeFileAtomic(path: string, data: string | Uint8Array, options?: WriteFileOptions): void {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    writeFileSync(tmp, data, options)
    renameSync(tmp, path)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/** A file the app asked the daemon to write: an absolute path with `extension`, in an existing folder. */
export function requireTarget(path: string, extension: string): void {
  if (!isAbsolute(path) || !path.endsWith(extension))
    throw new DaemonError('validation_failed', `The path must be an absolute ${extension} path`)
  if (!existsSync(dirname(path)))
    throw new DaemonError('validation_failed', 'The destination folder does not exist')
}
