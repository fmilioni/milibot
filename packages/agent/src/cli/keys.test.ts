import { CLI_ENGINES, cliSettingKeys } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { cliKeys } from './keys'

describe('cliKeys', () => {
  it('keeps the stored key strings of every engine', () => {
    expect(cliKeys('claude_code').lane('bot_1:ses_2')).toEqual([
      'claude_code.session.bot_1:ses_2',
      'claude_code.meta.bot_1:ses_2',
      'claude_code.bootstrap.bot_1:ses_2',
    ])
    expect(cliKeys('codex').lane('%')).toEqual(['codex.session.%', 'codex.meta.%', 'codex.bootstrap.%'])
  })

  it('matches the rotation settings the app writes', () => {
    for (const engine of CLI_ENGINES) {
      expect(cliKeys(engine).rotateIdleMinutes).toBe(cliSettingKeys(engine).rotateIdleMinutes)
      expect(cliKeys(engine).rotateContextTokens).toBe(cliSettingKeys(engine).rotateContextTokens)
    }
  })
})
