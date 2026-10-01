import { z } from 'zod'

import { type LineOp, lineOps } from '../core/diff'

/**
 * Files a single tool call changed (`file_edit`, `file_write`, `apply_patch`, Claude Code's Edit/Write). The
 * activity step carries only `EditedFile` (the card payload is rewritten on every step change); the patches
 * are kept per tool call and fetched when the user opens one.
 */
export const EditedFileStatus = z.enum(['added', 'modified', 'deleted', 'renamed'])
export type EditedFileStatus = z.infer<typeof EditedFileStatus>

export const EditedFile = z.object({
  /** Absolute path in the VM (`/workspace/...`). */
  path: z.string(),
  status: EditedFileStatus,
  additions: z.number().int(),
  deletions: z.number().int(),
})
export type EditedFile = z.infer<typeof EditedFile>

export const StepFileDiff = EditedFile.extend({
  /** Hunks of a unified diff (no file headers). */
  patch: z.string(),
  truncated: z.boolean(),
  /** For highlighting, from the extension. */
  language: z.string().optional(),
})
export type StepFileDiff = z.infer<typeof StepFileDiff>

export const StepDiff = z.object({
  toolCallId: z.string(),
  files: z.array(StepFileDiff),
})
export type StepDiff = z.infer<typeof StepDiff>

export const MAX_STEP_FILES = 20
export const MAX_STEP_PATCH_BYTES = 400_000
const CONTEXT = 3

/** Hunk in Claude Code's `structuredPatch` shape. */
export interface PatchHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

function textLines(text: string): string[] {
  if (text === '') return []
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
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

function hunkHeader(h: Omit<PatchHunk, 'lines'>): string {
  return `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`
}

/** Cuts a patch at a line boundary when it is over `MAX_STEP_PATCH_BYTES`. */
export function clipPatch(patch: string): { patch: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(patch)
  if (bytes.length <= MAX_STEP_PATCH_BYTES) return { patch, truncated: false }
  const cut = new TextDecoder().decode(bytes.subarray(0, MAX_STEP_PATCH_BYTES))
  const end = cut.lastIndexOf('\n')
  return { patch: end > 0 ? cut.slice(0, end) : cut, truncated: true }
}

/** Hunks (with real line numbers and a few context lines) turning `before` into `after`. */
export function unifiedPatch(
  before: string,
  after: string,
): { patch: string; additions: number; deletions: number } {
  const ops: LineOp[] = lineOps(textLines(before), textLines(after))
  const lastChangeAt: number[] = []
  let last = -Infinity
  ops.forEach((o, i) => {
    if (o.op !== ' ') last = i
    lastChangeAt[i] = last
  })
  let next = Infinity
  const keep = new Array<boolean>(ops.length)
  for (let i = ops.length - 1; i >= 0; i--) {
    if (ops[i]?.op !== ' ') next = i
    keep[i] = i - (lastChangeAt[i] as number) <= CONTEXT || next - i <= CONTEXT
  }
  const out: string[] = []
  let oldNo = 0
  let newNo = 0
  let i = 0
  while (i < ops.length) {
    if (!keep[i]) {
      if (ops[i]?.op !== '+') oldNo++
      if (ops[i]?.op !== '-') newNo++
      i++
      continue
    }
    const hunk: PatchHunk = { oldStart: oldNo + 1, oldLines: 0, newStart: newNo + 1, newLines: 0, lines: [] }
    for (; i < ops.length && keep[i]; i++) {
      const o = ops[i] as LineOp
      hunk.lines.push(`${o.op}${o.text}`)
      if (o.op !== '+') hunk.oldLines++
      if (o.op !== '-') hunk.newLines++
    }
    oldNo += hunk.oldLines
    newNo += hunk.newLines
    if (hunk.oldLines === 0) hunk.oldStart--
    if (hunk.newLines === 0) hunk.newStart--
    out.push(hunkHeader(hunk), ...hunk.lines)
  }
  return {
    patch: out.join('\n'),
    additions: ops.filter((o) => o.op === '+').length,
    deletions: ops.filter((o) => o.op === '-').length,
  }
}

/** Unified hunks from Claude Code's `structuredPatch`. */
export function patchFromHunks(hunks: readonly PatchHunk[]): {
  patch: string
  additions: number
  deletions: number
} {
  const out: string[] = []
  const body: string[] = []
  for (const h of hunks) {
    out.push(hunkHeader(h), ...h.lines)
    body.push(...h.lines)
  }
  return { patch: out.join('\n'), ...counts(body) }
}

export function editedFiles(diffs: readonly StepFileDiff[]): EditedFile[] {
  return diffs.map(({ path, status, additions, deletions }) => ({ path, status, additions, deletions }))
}
