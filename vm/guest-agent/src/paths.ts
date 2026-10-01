import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'

import { badRequest } from './errors.ts'

export const WORKSPACE_ROOT = '/workspace'

/** `/workspace` is a bind mount of the data disk (`milibot-data.service`). */
export function dataDiskMounted(): boolean {
  return existsSync('/data/workspace')
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + '/')
}

/** Lexical check: accepts paths relative to the root or absolute paths inside it. */
export function resolveInside(root: string, input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) throw badRequest('path is required', 'invalid_path')
  if (input.includes('\0')) throw badRequest('path contains NUL byte', 'invalid_path')
  const resolved = path.posix.resolve(root, input)
  if (!isInside(root, resolved)) throw badRequest(`path escapes ${root}`, 'path_outside_workspace')
  return resolved
}

function realpathOfExistingPrefix(p: string, realpath: (p: string) => string): string {
  const missing: string[] = []
  let current = p
  for (;;) {
    try {
      return path.posix.join(realpath(current), ...missing.reverse())
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      const parent = path.posix.dirname(current)
      if (parent === current) throw err
      missing.push(path.posix.basename(current))
      current = parent
    }
  }
}

/** Lexical check plus symlink resolution, so links pointing outside the root are rejected. */
export function resolveWorkspacePath(
  input: unknown,
  root = WORKSPACE_ROOT,
  realpath: (p: string) => string = realpathSync,
): string {
  const lexical = resolveInside(root, input)
  const realRoot = realpath(root)
  const real = realpathOfExistingPrefix(lexical, realpath)
  if (!isInside(realRoot, real))
    throw badRequest(`path escapes ${root} via symlink`, 'path_outside_workspace')
  return real
}
