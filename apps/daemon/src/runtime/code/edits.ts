import { ToolInputError } from '@milibot/agent/tools'
import { clipPatch, type StepFileDiff, unifiedPatch } from '@milibot/shared'

export interface TextEdit {
  oldText: string
  newText: string
  replaceAll: boolean
}

/** Applies edits in order, each on the result of the previous one; throws naming the first that fails. */
export function applyEdits(content: string, edits: TextEdit[]): { content: string; replacements: number } {
  let current = content
  let replacements = 0
  edits.forEach((edit, i) => {
    const label = edits.length > 1 ? `edits[${i}]: ` : ''
    if (!edit.oldText) throw new EditError(`${label}the old text is empty`)
    const count = current.split(edit.oldText).length - 1
    if (count === 0)
      throw new EditError(
        `${label}the old text was not found${i > 0 ? ' (after the previous edits)' : ''}; read the file again and copy the exact text`,
      )
    if (count > 1 && !edit.replaceAll)
      throw new EditError(`${label}the old text matches ${count} times; add more context or set replace_all`)
    current = edit.replaceAll
      ? current.split(edit.oldText).join(edit.newText)
      : current.replace(edit.oldText, () => edit.newText)
    replacements += edit.replaceAll ? count : 1
  })
  return { content: current, replacements }
}

export class EditError extends ToolInputError {}

/** Files bigger than this (before or after) are shown as changed without a diff. */
export const DIFF_MAX_BYTES = 1_000_000

/** Diff of a file the daemon wrote itself (`before` null = the file did not exist). */
export function fileWriteDiff(
  path: string,
  before: { content: string; truncated: boolean } | null,
  after: string,
): StepFileDiff {
  const status = before === null ? 'added' : 'modified'
  const old = before?.content ?? ''
  if (
    before?.truncated ||
    old.length > DIFF_MAX_BYTES ||
    after.length > DIFF_MAX_BYTES ||
    old.includes('\0')
  ) {
    return { path, status, additions: 0, deletions: 0, patch: '', truncated: true }
  }
  const diff = unifiedPatch(old, after)
  return { path, status, additions: diff.additions, deletions: diff.deletions, ...clipPatch(diff.patch) }
}
