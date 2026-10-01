import { posix } from 'node:path'

/**
 * A path of the file tools: absolute under /workspace, or relative to `base` (the lane's working directory,
 * itself under /workspace). Anything outside /workspace is refused.
 */
export function resolveWorkspacePath(path: string, base = '/workspace'): string | null {
  const root = base === '/workspace' || base.startsWith('/workspace/') ? base : '/workspace'
  const absolute = posix.normalize(path.startsWith('/') ? path : posix.join(root, path)).replace(/\/+$/, '')
  return absolute === '/workspace' || absolute.startsWith('/workspace/') ? absolute : null
}
