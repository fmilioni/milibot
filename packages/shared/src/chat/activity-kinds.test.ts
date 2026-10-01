import { describe, expect, it } from 'vitest'

import { ACTIVITY_STEP_KINDS, humanToolName } from './activity-kinds'

describe('activity kinds', () => {
  it('reads tool names as words', () => {
    expect(humanToolName('list_bots')).toBe('list bots')
    expect(humanToolName('NotebookRead')).toBe('Notebook Read')
    expect(humanToolName('mcp__github__create-issue')).toBe('create issue')
  })

  it('lists each kind once', () => {
    expect(new Set(ACTIVITY_STEP_KINDS).size).toBe(ACTIVITY_STEP_KINDS.length)
  })
})
