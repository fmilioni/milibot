import { PERSONA_MAX_TOKENS } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import {
  applyPersonaEdit,
  otherBotPersona,
  parsePersonaEdit,
  personaSizeError,
} from '../../../src/runtime/bots/persona-edit'

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

  it("names another bot's role section, the full-text argument and the patch that failed", () => {
    const scope = otherBotPersona('Ana')
    expect(parsePersonaEdit({ system_prompt: 'x', patch: [] }, scope)).toEqual({
      error: 'Pass either "system_prompt" or "patch", not both.',
    })
    expect(parsePersonaEdit({ patch: [] }, scope)).toMatchObject({
      error: expect.stringContaining('"system_prompt"'),
    })
    expect(parsePersonaEdit({ system_prompt: '  Full  ' }, scope)).toEqual({ newPersona: 'Full' })
    const failed = applyPersonaEdit(
      'You are Ana.',
      {
        patches: [
          { oldText: 'Ana', newText: 'Bia' },
          { oldText: 'Ana', newText: 'Carla' },
        ],
      },
      scope,
    )
    expect(failed).toMatchObject({ error: expect.stringContaining('the role section of Ana (patch 2 of 2') })
    expect(failed).toMatchObject({ error: expect.stringContaining('get_bot') })
  })

  it('refuses personas over the cap', () => {
    expect(personaSizeError('short')).toBeNull()
    const error = personaSizeError('word '.repeat(PERSONA_MAX_TOKENS * 2))
    expect(error).toContain(`limit of ${PERSONA_MAX_TOKENS}`)
    expect(error).toContain('memory_save')
  })
})
