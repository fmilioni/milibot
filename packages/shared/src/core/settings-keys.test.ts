import { describe, expect, it } from 'vitest'

import { CLI_ENGINES } from '../models/cli'
import * as keys from './settings-keys'

describe('settings keys', () => {
  it('gives every setting one key, except the preferences a group reuses', () => {
    const preferences = new Set<string>(Object.values(keys.PREFERENCE_SETTING_KEYS))
    const seen = new Map<string, string>()
    const clashes: string[] = []
    const groups = [
      ...Object.entries(keys),
      ...CLI_ENGINES.map((engine) => [`cliSettingKeys(${engine})`, keys.cliSettingKeys(engine)] as const),
    ]
    for (const [group, value] of groups) {
      if (typeof value === 'function') continue
      const entries = typeof value === 'string' ? [[group, value]] : Object.entries(value)
      for (const [field, key] of entries as [string, string][]) {
        const owner = `${group}.${field}`
        const other = seen.get(key)
        const reused = group !== 'PREFERENCE_SETTING_KEYS' && preferences.has(key)
        if (other && !reused) clashes.push(`${key}: ${other}, ${owner}`)
        if (!reused) seen.set(key, owner)
        expect(key).toMatch(/^[a-z_]+(\.[a-z_]+)+$/)
      }
    }
    expect(clashes).toEqual([])
  })

  it('keeps the stored keys of the CLI engine settings', () => {
    expect(keys.cliSettingKeys('claude_code')).toEqual({
      rotateIdleMinutes: 'claude_code.rotate_idle_minutes',
      rotateContextTokens: 'claude_code.rotate_context_tokens',
      compactSystemPrompt: 'claude_code.compact_system_prompt',
    })
    expect(keys.cliSettingKeys('codex').rotateContextTokens).toBe('codex.rotate_context_tokens')
  })
})
