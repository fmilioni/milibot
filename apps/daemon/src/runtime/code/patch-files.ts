import { posix } from 'node:path'

import { clipPatch, MAX_STEP_FILES, type StepFileDiff } from '@milibot/shared'

function headerPath(raw: string): string {
  const path = raw.replace(/\t.*$/, '').trim()
  return path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path
}

function stripPrefix(path: string, prefix: 'a/' | 'b/', strip: boolean): string {
  return strip && path.startsWith(prefix) ? path.slice(prefix.length) : path
}

function counts(lines: readonly string[]): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of lines) {
    if (line.startsWith('+')) additions++
    else if (line.startsWith('-')) deletions++
  }
  return { additions, deletions }
}

/**
 * Splits a (git or plain) unified diff into its files, with paths as written in the patch (`a/`/`b/`
 * prefixes removed when both sides have them) and counts taken from the hunks.
 */
export function splitPatchByFile(patch: string): StepFileDiff[] {
  const files: Array<{ oldPath: string; newPath: string; renamed: boolean; lines: string[] }> = []
  let current: (typeof files)[number] | null = null
  const lines = patch.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const nextLine = lines[i + 1]
    if (line.startsWith('diff --git ')) {
      current = { oldPath: '', newPath: '', renamed: false, lines: [] }
      files.push(current)
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
      if (m) {
        current.oldPath = `a/${m[1]}`
        current.newPath = `b/${m[2]}`
      }
      continue
    }
    if (line.startsWith('--- ') && nextLine?.startsWith('+++ ')) {
      if (!current || current.lines.length) {
        current = { oldPath: '', newPath: '', renamed: false, lines: [] }
        files.push(current)
      }
      current.oldPath = headerPath(line.slice(4))
      current.newPath = headerPath(nextLine.slice(4))
      i++
      continue
    }
    if (!current) continue
    if (line.startsWith('rename from ') || line.startsWith('rename to ')) current.renamed = true
    if (line.startsWith('@@') || current.lines.length) current.lines.push(line)
  }
  return files
    .filter((f) => f.newPath || f.oldPath)
    .map((f) => {
      const added = f.oldPath === '/dev/null'
      const deleted = f.newPath === '/dev/null'
      const prefixed =
        (added || f.oldPath.startsWith('a/')) &&
        (deleted || f.newPath.startsWith('b/')) &&
        !(added && deleted)
      const path = deleted ? stripPrefix(f.oldPath, 'a/', prefixed) : stripPrefix(f.newPath, 'b/', prefixed)
      while (f.lines.length && f.lines.at(-1) === '') f.lines.pop()
      const clipped = clipPatch(f.lines.join('\n'))
      return {
        path,
        status: added ? 'added' : deleted ? 'deleted' : f.renamed ? 'renamed' : 'modified',
        ...counts(f.lines.filter((l) => !l.startsWith('@@'))),
        ...clipped,
      }
    })
}

/**
 * Files `scripts/apply-patch.sh` touched (its `git apply --numstat` lines, paths relative to `dir`) with their
 * part of the patch; the counts are git's.
 */
export function appliedPatchFiles(numstat: string, patch: string, dir: string): StepFileDiff[] {
  const parts = new Map(splitPatchByFile(patch).map((f) => [f.path, f]))
  const files: StepFileDiff[] = []
  for (const line of numstat.split('\n')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim())
    if (!match) continue
    const relative = match[3] as string
    const part = parts.get(relative)
    files.push({
      path: posix.join(dir, relative),
      status: part?.status ?? 'modified',
      additions: match[1] === '-' ? 0 : Number(match[1]),
      deletions: match[2] === '-' ? 0 : Number(match[2]),
      patch: part?.patch ?? '',
      truncated: part?.truncated ?? false,
    })
    if (files.length >= MAX_STEP_FILES) break
  }
  return files
}
