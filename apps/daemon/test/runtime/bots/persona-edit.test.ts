import { PERSONA_MAX_TOKENS } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { applyPersonaEdit, parsePersonaEdit, personaSizeError } from '../../../src/runtime/bots/persona-edit'

describe('persona edits', () => {
  it('replaces exact text, appends with an empty old_text and reports what is wrong', () => {
    const current = 'You are Ana.\nYou track expenses.'
    const edit = parsePersonaEdit({
      patch: [
        { old_text: 'You track expenses.', new_text: 'You track expenses and cash flow.' },
        { old_text: '', new_text: 'Always show the math.' },
      ],
    })
    if ('error' in edit) throw new Error(edit.error)
    expect(applyPersonaEdit(current, edit)).toEqual({
      text: 'You are Ana.\nYou track expenses and cash flow.\nAlways show the math.',
    })
    expect(applyPersonaEdit(current, { patches: [{ oldText: 'nope', newText: 'x' }] })).toMatchObject({
      error: expect.stringContaining('was not found'),
    })
    expect(applyPersonaEdit('a a', { patches: [{ oldText: 'a', newText: 'b' }] })).toMatchObject({
      error: expect.stringContaining('more than once'),
    })
    expect(parsePersonaEdit({ new_persona: 'x', patch: [] })).toMatchObject({ error: expect.any(String) })
    expect(parsePersonaEdit({})).toMatchObject({ error: expect.any(String) })
    expect(parsePersonaEdit({ patch: { new_text: 'solo' } })).toEqual({
      patches: [{ oldText: '', newText: 'solo' }],
    })
  })

  it('refuses personas over the cap', () => {
    expect(personaSizeError('short')).toBeNull()
    const error = personaSizeError('word '.repeat(PERSONA_MAX_TOKENS * 2))
    expect(error).toContain(`limit of ${PERSONA_MAX_TOKENS}`)
    expect(error).toContain('memory_save')
  })
})
