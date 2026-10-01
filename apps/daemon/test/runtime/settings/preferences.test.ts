import { pullRequestNote } from '@milibot/agent/prompts'
import { PREFERENCE_SETTING_KEYS } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { botSliceLimits, planMergeAllowed, readPreferences } from '../../../src/runtime/settings/preferences'

function getter(values: Record<string, unknown>) {
  return <T>(key: string, fallback: T): T => (key in values ? (values[key] as T) : fallback)
}

describe('preferences', () => {
  it('reads preferences with defaults for missing or invalid values', () => {
    const prefs = readPreferences(
      getter({
        [PREFERENCE_SETTING_KEYS.maxParallelBots]: 5,
        [PREFERENCE_SETTING_KEYS.spendWarnUsd]: 'lots',
        [PREFERENCE_SETTING_KEYS.summaryModel]: { providerId: 'p', model: 'haiku' },
      }),
    )
    expect(prefs).toMatchObject({
      maxParallelBots: 5,
      spendWarnUsd: null,
      summaryModel: { providerId: 'p', model: 'haiku' },
      payloadRetentionDays: 30,
      draftPrs: true,
    })
  })

  it('writes the pull request rules for the workspace, a plan that may merge and one that may not', () => {
    const workspace = pullRequestNote({ draftPrs: true, autoMergePrs: false, mergeAllowed: undefined })
    expect(workspace).toContain('`gh pr create --draft`')
    expect(workspace).toContain('Never merge pull requests (`gh pr merge`)')
    expect(workspace).toContain('unless your approved plan or session brief allows it')
    expect(pullRequestNote({ draftPrs: false, autoMergePrs: true, mergeAllowed: undefined })).toMatch(
      /ready for review[\s\S]*You may merge/,
    )
    expect(pullRequestNote({ draftPrs: true, autoMergePrs: false, mergeAllowed: true })).toContain(
      'Merging is allowed here',
    )
    expect(pullRequestNote({ draftPrs: true, autoMergePrs: true, mergeAllowed: false })).toContain(
      'Do not merge the pull request',
    )
    expect(planMergeAllowed({ mergePr: null }, true)).toBe(true)
    expect(planMergeAllowed({ mergePr: false }, true)).toBe(false)
    expect(planMergeAllowed({ mergePr: true }, false)).toBe(true)
    expect(readPreferences(getter({}))).toMatchObject({ autoMergePrs: false, userLanguage: 'pt-BR' })
  })

  it('turns the per-bot preferences into slice limits', () => {
    const defaults = readPreferences(getter({}))
    expect(defaults).toMatchObject({ perBotLimits: false, perBotCpuPercent: 150, perBotMemoryGb: 3 })
    expect(botSliceLimits(defaults)).toBeNull()
    expect(botSliceLimits({ ...defaults, perBotLimits: true, perBotMemoryGb: 4 })).toEqual({
      cpuPercent: 150,
      memoryMb: 4096,
    })
  })
})
