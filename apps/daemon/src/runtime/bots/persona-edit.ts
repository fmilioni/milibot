import { estimateTokens, PERSONA_MAX_TOKENS } from '@milibot/shared'

interface PersonaPatch {
  oldText: string
  newText: string
}

export type PersonaEdit = { newPersona: string } | { patches: PersonaPatch[] }

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Reads `new_persona` or `patch` (one `{old_text, new_text}` or a list) from tool arguments. */
export function parsePersonaEdit(args: Record<string, unknown>): PersonaEdit | { error: string } {
  const full = stringOrNull(args.new_persona)
  const rawPatch = args.patch
  if (full !== null && rawPatch !== undefined)
    return { error: 'Pass either "new_persona" or "patch", not both.' }
  if (full !== null) {
    if (!full.trim()) return { error: '"new_persona" is empty.' }
    return { newPersona: full.trim() }
  }
  const items = Array.isArray(rawPatch)
    ? rawPatch
    : rawPatch && typeof rawPatch === 'object'
      ? [rawPatch]
      : []
  const patches: PersonaPatch[] = []
  for (const item of items as Array<Record<string, unknown>>) {
    const oldText = stringOrNull(item?.old_text) ?? ''
    const newText = stringOrNull(item?.new_text)
    if (newText === null)
      return { error: 'Each patch needs "new_text" (and "old_text" to replace; empty appends).' }
    patches.push({ oldText, newText })
  }
  if (patches.length === 0) return { error: 'Pass "new_persona" (the whole new text) or "patch".' }
  return { patches }
}

/** Applies the edit to the current persona; patches replace exact text (empty `oldText` appends). */
export function applyPersonaEdit(current: string, edit: PersonaEdit): { text: string } | { error: string } {
  if ('newPersona' in edit) return { text: edit.newPersona }
  let text = current
  for (const patch of edit.patches) {
    if (!patch.oldText) {
      text = text ? `${text.trimEnd()}\n${patch.newText.trim()}` : patch.newText.trim()
      continue
    }
    const at = text.indexOf(patch.oldText)
    if (at < 0)
      return {
        error: `"old_text" was not found in your current role section: ${patch.oldText.slice(0, 80)}. Copy it exactly, or send "new_persona".`,
      }
    if (text.indexOf(patch.oldText, at + 1) >= 0)
      return { error: `"old_text" appears more than once; include more of the surrounding text.` }
    text = text.slice(0, at) + patch.newText + text.slice(at + patch.oldText.length)
  }
  return { text: text.trim() }
}

/** Error for the model when the persona is over the cap; null when it fits. */
export function personaSizeError(text: string): string | null {
  const tokens = estimateTokens(text)
  if (tokens <= PERSONA_MAX_TOKENS) return null
  return (
    `Not applied: the new role section would be about ${tokens} tokens, over the limit of ${PERSONA_MAX_TOKENS}. ` +
    'Consolidate it: keep only who you are, your scope and how you work, in fewer words; move facts, lists, ' +
    'names, accounts and preferences to memory_save; then send the shorter version.'
  )
}
