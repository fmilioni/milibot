import { estimateTokens, PERSONA_MAX_TOKENS } from '@milibot/shared'

interface PersonaPatch {
  oldText: string
  newText: string
}

export type PersonaEdit = { newPersona: string } | { patches: PersonaPatch[] }

/** Whose role section an edit changes, for the argument names and error messages. */
export interface PersonaEditScope {
  /** The argument that carries the whole new text. */
  fullKey: 'new_persona' | 'system_prompt'
  /** "your current role section", "the role section of Ana". */
  subject: string
  /** How to see the current text again when an `old_text` does not match. */
  reread: string
}

export const OWN_PERSONA: PersonaEditScope = {
  fullKey: 'new_persona',
  subject: 'your current role section',
  reread: 'Copy it exactly from your instructions',
}

export function otherBotPersona(name: string): PersonaEditScope {
  return {
    fullKey: 'system_prompt',
    subject: `the role section of ${name}`,
    reread: 'Read it again with get_bot and copy it exactly',
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Reads the whole text (`scope.fullKey`) or `patch` (one `{old_text, new_text}` or a list) from tool arguments. */
export function parsePersonaEdit(
  args: Record<string, unknown>,
  scope: PersonaEditScope = OWN_PERSONA,
): PersonaEdit | { error: string } {
  const key = scope.fullKey
  const full = stringOrNull(args[key])
  const rawPatch = args.patch
  if (full !== null && rawPatch !== undefined) return { error: `Pass either "${key}" or "patch", not both.` }
  if (full !== null) {
    if (!full.trim()) return { error: `"${key}" is empty.` }
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
  if (patches.length === 0) return { error: `Pass "${key}" (the whole new text) or "patch".` }
  return { patches }
}

/**
 * Applies the edit to the current persona; patches replace exact text (empty `oldText` appends), in order and
 * all or none: the first one that does not match exactly once fails the whole edit.
 */
export function applyPersonaEdit(
  current: string,
  edit: PersonaEdit,
  scope: PersonaEditScope = OWN_PERSONA,
): { text: string } | { error: string } {
  if ('newPersona' in edit) return { text: edit.newPersona }
  let text = current
  const many = edit.patches.length > 1
  for (const [index, patch] of edit.patches.entries()) {
    if (!patch.oldText) {
      text = text ? `${text.trimEnd()}\n${patch.newText.trim()}` : patch.newText.trim()
      continue
    }
    const which = many ? ` (patch ${index + 1} of ${edit.patches.length}; nothing was applied)` : ''
    const at = text.indexOf(patch.oldText)
    if (at < 0)
      return {
        error:
          `"old_text" was not found in ${scope.subject}${which}: ${patch.oldText.slice(0, 80)}. ` +
          `${scope.reread}, or send "${scope.fullKey}".`,
      }
    if (text.indexOf(patch.oldText, at + 1) >= 0)
      return {
        error: `"old_text" appears more than once in ${scope.subject}${which}; include more of the surrounding text.`,
      }
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
