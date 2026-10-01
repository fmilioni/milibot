import { describe, expect, it } from 'vitest'

import { ToolCallStore } from '../../../src/runtime/observability/tool-calls'
import { WorkspaceStore } from '../../../src/runtime/workspace-store'
import { openWorkspaceDb } from '../../../src/workspace-db/open'

describe('bot activity log', () => {
  it('humanizes tool calls like the activity card and hides Claude Code internals', () => {
    const db = openWorkspaceDb(':memory:')
    let clock = 1_000
    const now = () => clock
    const store = new WorkspaceStore(db, now)
    const toolCalls = new ToolCallStore(db)
    const bot = store.bots.create({ name: 'Ana' })
    const longCommand = `uname -r && ${'echo checking && '.repeat(10)}true`
    const calls: Array<[string, unknown, string | null]> = [
      ['ToolSearch', { query: 'select:mcp__milibot__computer,mcp__milibot__memory_search' }, null],
      ['mcp__milibot__computer', { action: 'click', x: 640, y: 772 }, null],
      ['computer', { action: 'screenshot' }, 'abc123'],
      ['Bash', { command: longCommand, description: 'Kernel' }, null],
      ['TodoWrite', { todos: [] }, null],
      ['mcp__milibot__computer', { action: 'type', text: 'x'.repeat(100) }, null],
    ]
    calls.forEach(([toolName, args, sha], i) => {
      const id = `tc_${i}`
      clock += 10
      toolCalls.start({
        id,
        llmCallId: null,
        botId: bot.id,
        conversationId: null,
        turnId: null,
        toolName,
        arguments: args,
        startedAt: clock,
      })
      toolCalls.finish(id, {
        status: 'ok',
        result: null,
        error: null,
        screenshotSha: sha,
        finishedAt: clock + 5,
      })
    })

    const log = toolCalls.botActivity(bot.id, 10)
    expect(log.map((a) => [a.kind, a.detail.slice(0, 20)])).toEqual([
      ['type', 'x'.repeat(20)],
      ['bash', 'uname -r && echo che'],
      ['screenshot', ''],
      ['click', '(640, 772)'],
    ])
    expect(log[0]?.fullDetail).toBe('x'.repeat(100))
    expect(log[1]?.detail.endsWith('…')).toBe(true)
    expect(log[1]?.fullDetail).toBe(longCommand)
    expect(log[2]?.screenshotSha).toBe('abc123')
    expect(log[3]?.fullDetail).toBeUndefined()
    expect(toolCalls.botActivity(bot.id, 2)).toHaveLength(2)
  })
})
