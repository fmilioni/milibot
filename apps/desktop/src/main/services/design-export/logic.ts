import { escapeAttribute, printDocument } from '@milibot/shared'

import type { DesignExportFrame } from '../../../bridge/contract'

/** Chromium refuses screenshots past this many pixels per side. */
export const MAX_EXPORT_SIDE = 16_384
const MAX_EXPORT_PIXELS = 120_000_000

/** The PNG scale actually used: the requested one, lowered until the image fits Chromium's limits. */
export function exportScale(width: number, height: number, requested: number): number {
  const wanted = Math.min(3, Math.max(0.25, requested))
  const bySide = MAX_EXPORT_SIDE / Math.max(width, height, 1)
  const byArea = Math.sqrt(MAX_EXPORT_PIXELS / Math.max(1, width * height))
  return Math.min(wanted, bySide, byArea)
}

/** A file name from a design or frame name (no path separators or characters file systems reject). */
export function exportFileName(name: string, extension: string): string {
  return `${exportBaseName(name)}.${extension}`
}

function exportBaseName(name: string): string {
  return (
    name
      .normalize('NFC')
      // eslint-disable-next-line no-control-regex -- control characters are not allowed in file names
      .replace(/[/\\:*?"<>|\u0000-\u001f]+/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/^[\s.-]+|[\s.-]+$/g, '')
      .slice(0, 120) || 'design'
  )
}

/** File names (without extension) for frames saved side by side: repeated names get " (2)", " (3)"… */
export function uniqueBaseNames(names: readonly string[]): string[] {
  const taken = new Set<string>()
  return names.map((name) => {
    const base = exportBaseName(name)
    let candidate = base
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base} (${n})`
    taken.add(candidate.toLowerCase())
    return candidate
  })
}

/**
 * One document with a page per frame: each frame's own page in an `<iframe srcdoc>` (their styles must not
 * mix), sized by `PRINT_PREPARE_SCRIPT` (named @page per frame) before `printToPDF`.
 */
export function framesPrintDocument(frames: readonly DesignExportFrame[]): string {
  return printDocument(frames, (f) => `srcdoc="${escapeAttribute(f.html)}"`)
}
