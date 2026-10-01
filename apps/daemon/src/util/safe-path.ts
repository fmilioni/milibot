import path, { type PlatformPath, posix } from 'node:path'

const MAX_NAME_LENGTH = 120

/**
 * A file name that is safe as one path segment in the VM: no separators or control characters, no
 * leading dots (hidden files, `..`), at most 120 characters with the extension kept.
 */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  let clean = base
    .normalize('NFC')
    .replace(/\p{Cc}/gu, '')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .replace(/^\.+/, '')
    .trim()
  if (!clean) clean = 'file'
  if (clean.length > MAX_NAME_LENGTH) {
    const ext = posix.extname(clean).slice(0, 16)
    clean = `${clean.slice(0, MAX_NAME_LENGTH - ext.length).trimEnd()}${ext}`
  }
  return clean
}

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\s*(\..*)?$/i

/**
 * A name from the VM or the database that is safe as one file name on the host, Windows included: also no
 * trailing dots or spaces (NTFS drops them) and no reserved device names (`CON`, `NUL.txt`, `COM1`…).
 */
export function hostSafeName(name: string): string {
  const clean = sanitizeFileName(name).replace(/[. ]+$/, '')
  if (!clean) return 'file'
  return WINDOWS_RESERVED_NAME.test(clean) ? `_${clean}` : clean
}

const UNSAFE_PART = /[\\:]|^\.{0,2}$/

/**
 * `root` joined with path segments taken from outside (zip entries, VM paths), or null when a segment is
 * empty, `.`/`..`, absolute or has `\` or `:` (a drive letter or an NTFS stream), or the result leaves
 * `root`.
 */
export function containedJoin(
  root: string,
  parts: readonly string[],
  pathImpl: PlatformPath = path,
): string | null {
  if (!parts.length || parts.some((p) => UNSAFE_PART.test(p) || pathImpl.isAbsolute(p))) return null
  const target = pathImpl.join(root, ...parts)
  const relative = pathImpl.relative(root, target)
  if (!relative || relative === '..' || relative.startsWith(`..${pathImpl.sep}`)) return null
  return pathImpl.isAbsolute(relative) ? null : target
}
