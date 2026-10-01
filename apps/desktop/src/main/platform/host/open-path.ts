import { statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, normalize, relative, sep } from 'node:path'

/**
 * Files the default app shows without running code: images, PDF, plain text and data, Office
 * formats that cannot hold macros, audio and video. Everything else (scripts, installers, shortcuts,
 * disk images, macro-enabled or old Office files, HTML/SVG) is shown in the file manager instead.
 */
const VIEWABLE = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.tif',
  '.tiff',
  '.heic',
  '.heif',
  '.avif',
  '.pdf',
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.tsv',
  '.json',
  '.log',
  '.docx',
  '.xlsx',
  '.pptx',
  '.mp3',
  '.wav',
  '.m4a',
  '.aac',
  '.ogg',
  '.oga',
  '.opus',
  '.flac',
  '.mp4',
  '.m4v',
  '.mov',
  '.webm',
  '.mkv',
  '.avi',
])

/**
 * Attachments are opened with their default app only when that cannot run code (else they are shown
 * in the file manager). On macOS and Linux the executable bit also counts; Windows has no such bit.
 */
export function isSafeToOpen(
  path: string,
  stat: (p: string) => { isFile(): boolean; mode: number } = statSync,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!VIEWABLE.has(extname(path).toLowerCase())) return false
  try {
    const info = stat(path)
    if (!info.isFile()) return false
    return platform === 'win32' || (info.mode & 0o111) === 0
  } catch {
    return false
  }
}

const EXPORT_FOLDERS = new Set(['milibot-knowledge', 'milibot-attachments'])

/**
 * "Download" only copies files the daemon exported for download (`<tmp>/milibot-knowledge/<id>/<name>`,
 * `<tmp>/milibot-attachments/<id>/<name>`), never an arbitrary path the renderer names.
 */
export function isExportedFile(path: string, stat: (p: string) => { isFile(): boolean } = statSync): boolean {
  if (!isAbsolute(path) || normalize(path) !== path) return false
  if (!EXPORT_FOLDERS.has(basename(dirname(dirname(path))))) return false
  try {
    return stat(path).isFile()
  } catch {
    return false
  }
}

/** Whether `path` is `root` or inside it (absolute, without `..` segments). */
export function isInside(path: string, root: string): boolean {
  if (!isAbsolute(path) || normalize(path) !== path) return false
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * "Show in folder" only for paths the app hands out: exported downloads and anything under `roots` (the
 * data root with the workspace folders and their skills, the built-in skills).
 */
export function isRevealable(
  path: string,
  roots: readonly string[],
  stat: (p: string) => { isFile(): boolean } = statSync,
): boolean {
  return isExportedFile(path, stat) || roots.some((root) => isInside(path, root))
}
