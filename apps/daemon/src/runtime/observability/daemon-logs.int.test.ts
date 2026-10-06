import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ToolExecContext } from '@milibot/agent'
import { makeBot } from '@milibot/agent/testing'
import { redactSecrets } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { useTempDir } from '../../../test/support/temp'
import { DaemonLogTools, type DaemonLogToolsDeps, readDaemonLog } from './daemon-logs'

const WS = 'ws_01MINE'
const NOW = Date.parse('2026-10-06T12:00:00Z')
const me = makeBot({ id: 'bot_01ME', name: 'Theo' })
const other = makeBot({ id: 'bot_01OTHER', name: 'Lina' })
const SECRET = 'super-secret-value-123'

const rec = (minutesAgo: number, fields: Record<string, unknown>) =>
  JSON.stringify({ level: 30, time: NOW - minutesAgo * 60_000, pid: 1, hostname: 'mac', ...fields })

function tool(path: string | null) {
  const deps: DaemonLogToolsDeps = {
    workspaceId: WS,
    path,
    resolveBot: (ref) =>
      [me, other].find((b) => b.id === ref || b.name.toLowerCase() === ref.toLowerCase()) ?? null,
    botName: (id) => [me, other].find((b) => b.id === id)?.name ?? null,
    now: () => NOW,
  }
  const provider = new DaemonLogTools(deps)
  const ctx: ToolExecContext = {
    bot: me,
    conversationId: null,
    turnId: null,
    signal: new AbortController().signal,
  }
  return async (args: Record<string, unknown> = {}) => {
    // As the runtime's tool registry does: known secret values never leave a tool.
    const result = redactSecrets(
      await provider.execute(ctx, { id: 'c1', name: 'daemon_logs', arguments: args }),
      [SECRET],
    )
    const text = result.content.map((p) => (p.type === 'text' ? p.text : '')).join('')
    return { text, lines: text.split('\n').slice(0, -1), footer: text.split('\n').at(-1) ?? '', result }
  }
}

describe('daemon_logs', () => {
  const dir = useTempDir('daemon-logs')

  function writeLog(lines: string[]): string {
    const path = join(dir(), 'daemon.log')
    writeFileSync(path, `${lines.join('\n')}\n`)
    return path
  }

  const fixture = () =>
    writeLog([
      rec(180, { workspaceId: WS, msg: 'too old', botId: me.id }),
      rec(50, { msg: 'supervisor started', port: 4000 }),
      rec(40, { workspaceId: 'ws_01OTHER', msg: 'other workspace', botId: me.id }),
      'node: warning printed by a library',
      '{not json',
      rec(30, { workspaceId: WS, msg: 'turn.start', botId: me.id, botName: 'Theo', lane: me.id }),
      rec(29, { workspaceId: WS, level: 20, msg: 'debug detail', botId: me.id }),
      rec(28, { workspaceId: WS, msg: 'turn.start', botId: other.id, botName: 'Lina', lane: other.id }),
      rec(20, {
        workspaceId: WS,
        level: 50,
        msg: 'provider failed',
        botId: me.id,
        err: `Bearer abcdefghijklmnop ${SECRET}`,
      }),
      rec(10, { workspaceId: WS, msg: 'helper close', laneKey: `${me.id}:wses_1:sub:0` }),
      rec(5, { workspaceId: WS, level: 40, msg: 'lane.close', botId: other.id, botName: 'Lina' }),
    ])

  it('shows only this workspace, newest last, with a footer', async () => {
    const run = tool(fixture())
    const { lines, footer, text } = await run()
    expect(lines.map((l) => l.replace(/^\S+ \S+ /, ''))).toEqual([
      'INFO Theo: turn.start lane=bot_01ME',
      'INFO Lina: turn.start lane=bot_01OTHER',
      `ERROR Theo: provider failed err=Bearer [REDACTED] ••••••`,
      'INFO -: helper close laneKey=bot_01ME:wses_1:sub:0',
      'WARN Lina: lane.close',
    ])
    expect(footer).toContain('5 line(s); all matching lines since the start time')
    expect(text).not.toContain('other workspace')
    expect(text).not.toContain('supervisor started')
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('abcdefghijklmnop')
  })

  it('filters by bot ("me" or a name), level, text and start time', async () => {
    const run = tool(fixture())
    expect((await run({ bot: 'me' })).lines.map((l) => l.split(': ')[1])).toEqual([
      'turn.start lane=bot_01ME',
      'provider failed err=Bearer [REDACTED] ••••••',
      'helper close laneKey=bot_01ME:wses_1:sub:0',
    ])
    expect((await run({ bot: 'lina' })).lines).toHaveLength(2)
    expect((await run({ level: 'warn' })).lines).toHaveLength(2)
    expect((await run({ level: 'debug', bot: 'me' })).lines).toHaveLength(4)
    expect((await run({ contains: 'TURN.START' })).lines).toHaveLength(2)
    expect((await run({ since: '15m' })).lines).toHaveLength(2)
    expect((await run({ since: new Date(NOW - 25 * 60_000).toISOString() })).lines).toHaveLength(3)
    expect((await run({ since: '4h', include_supervisor: true })).text).toContain(
      '[supervisor]: supervisor started',
    )
    expect((await run({ include_supervisor: true })).text).toContain(
      '[raw] node: warning printed by a library',
    )
    expect((await run({ contains: 'warning printed' })).lines).toHaveLength(1)
    expect((await run({ bot: 'nobody' })).result.isError).toBe(true)
    expect((await run({ since: 'yesterday-ish' })).result.isError).toBe(true)
  })

  it('stops at the limit and reports it', async () => {
    const run = tool(fixture())
    const { lines, footer } = await run({ limit: 2 })
    expect(lines.map((l) => l.split(': ')[1])).toEqual([
      'helper close laneKey=bot_01ME:wses_1:sub:0',
      'lane.close',
    ])
    expect(footer).toContain('limit of 2 lines reached')
  })

  it('reads a large file from its end only', async () => {
    const filler = Array.from({ length: 12_000 }, (_, i) =>
      rec(60 * 24 * 5, { workspaceId: 'ws_01OTHER', msg: `old ${i} ${'x'.repeat(80)}` }),
    )
    const recent = Array.from({ length: 1500 }, (_, i) => rec(1, { workspaceId: WS, msg: `recent ${i}` }))
    const path = writeLog([...filler, ...recent])
    const run = tool(path)
    const all = await run({ limit: 1000 })
    expect(all.lines).toHaveLength(1000)
    expect(all.lines.at(-1)).toContain('recent 1499')
    expect(all.footer).toContain('limit of 1000')
    const since = await run({ since: '1d', limit: 1000, contains: 'recent 7' })
    expect(since.lines.length).toBeGreaterThan(0)
    expect(since.footer).toContain('since the start time')
  })

  it('stops at the read cap', async () => {
    const path = writeLog(
      Array.from({ length: 5000 }, (_, i) => rec(1, { workspaceId: 'ws_01OTHER', msg: `n ${i}` })),
    )
    const query = { sinceMs: 0, minLevel: 30, botId: null, contains: null, limit: 10, supervisor: false }
    const result = await readDaemonLog(path, query, {} as DaemonLogToolsDeps, 64 * 1024)
    expect(result).toEqual({ lines: [], stop: 'cap' })
  })

  it('answers plainly when the daemon writes no log file', async () => {
    for (const path of [null, join(dir(), 'missing.log')]) {
      const { text, result } = await tool(path)()
      expect(result.isError).toBeFalsy()
      expect(text).toContain('not writing its log to a file')
    }
  })
})
