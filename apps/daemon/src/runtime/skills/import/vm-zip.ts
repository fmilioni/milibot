import { posix } from 'node:path'

import type { GuestClient } from '../../vm'
import { validation } from './scan'

/** Largest zip a bot imports from the VM (the same as a GitHub archive). */
export const VM_ZIP_MAX_BYTES = 50 * 1024 * 1024

/** Resolves the path as `agent` (what the bot can read), symlinks included, and prints it with its size. */
const RESOLVE_SCRIPT = [
  'set -e',
  'p=$(realpath -e -- "$SRC")',
  'test -f "$p"',
  'test -r "$p"',
  'printf \'%s\\n\' "$p"',
  'stat -c %s -- "$p"',
].join('\n')

/** The checked path of a zip under /workspace, before reading it. */
export function vmZipPath(input: string): string {
  const path = posix.normalize(input.trim())
  if (!path.startsWith('/workspace/') || path.includes('\0'))
    throw validation('The zip must be a file under /workspace.', 'invalid_path')
  if (!/\.(zip|skill)$/i.test(path)) throw validation('Only .zip or .skill files.', 'invalid_extension')
  return path
}

/**
 * A `.zip`/`.skill` file under /workspace in the VM: resolved as `agent` (a symlink must still land under
 * /workspace), at most `VM_ZIP_MAX_BYTES`.
 */
export async function readVmZip(guest: GuestClient, input: string): Promise<{ path: string; data: Buffer }> {
  const path = vmZipPath(input)
  const resolved = await guest.exec({
    user: 'agent',
    cmd: RESOLVE_SCRIPT,
    env: { SRC: path },
    timeoutMs: 30_000,
  })
  const [real, size] = resolved.stdout.split('\n')
  if (resolved.code !== 0 || !real)
    throw validation(`Could not read ${path}: not a file you can read.`, 'path_not_found', { path })
  if (!real.startsWith('/workspace/'))
    throw validation(`${path} points outside /workspace.`, 'invalid_path', { path })
  const tooLarge = () =>
    validation(`The zip is larger than ${VM_ZIP_MAX_BYTES / 1024 / 1024} MB.`, 'too_large', { path })
  if (Number(size) > VM_ZIP_MAX_BYTES) throw tooLarge()
  const data = await guest.fsReadAll(real, { maxBytes: VM_ZIP_MAX_BYTES, tooLarge })
  return { path: real, data }
}
