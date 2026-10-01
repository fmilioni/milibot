import { describe, expect, it } from 'vitest'

import { milibotToolName } from '../mcp/names'
import { turnFixture } from '../test-support/claude-code'
import { parseStreamJsonLine, userInputLine } from './stream-json'

describe('stream-json parser', () => {
  it('parses a full turn', () => {
    const events = turnFixture.map(parseStreamJsonLine)
    expect(events[0]).toMatchObject({
      type: 'init',
      sessionId: '8f3c2a1e-0000-4000-8000-000000000001',
      mcpServers: [{ name: 'milibot', status: 'connected' }],
    })
    expect(events.filter((e) => e?.type === 'text_delta').map((e) => (e as { text: string }).text)).toEqual([
      'Listing ',
      'the files.',
      'The folder is empty.',
    ])
    expect(events[6]).toMatchObject({
      type: 'assistant',
      toolUses: [{ id: 'toolu_bash1', name: 'Bash', input: { command: 'ls -la /workspace' } }],
    })
    expect(events[10]).toMatchObject({
      type: 'tool_results',
      results: [
        { toolUseId: 'toolu_mcp1', isError: false, text: 'Screenshot of your display (1280x800).\n[image]' },
      ],
    })
    expect(events.at(-1)).toEqual({
      type: 'result',
      subtype: 'success',
      isError: false,
      text: 'The folder is empty.',
      sessionId: '8f3c2a1e-0000-4000-8000-000000000001',
      costUsd: 0.0421,
      durationMs: 8123,
      numTurns: 3,
      usage: {
        inputTokens: 9,
        cachedReadTokens: 12000,
        cacheWriteTokens: 5000,
        outputTokens: 91,
        reasoningTokens: 0,
      },
      modelUsage: [
        {
          model: 'claude-sonnet-5',
          inputTokens: 9,
          cachedReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 91,
          reasoningTokens: 0,
          costUsd: 0.0421,
          webSearchRequests: 0,
        },
      ],
      errors: [],
    })
    expect(parseStreamJsonLine('not json')).toBeNull()
    expect(parseStreamJsonLine('{"type":"weird"}')).toEqual({ type: 'other', raw: { type: 'weird' } })
  })

  it('formats input and recognizes Milibot MCP tools', () => {
    expect(JSON.parse(userInputLine('hello'))).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    })
    expect(milibotToolName('mcp__milibot__computer')).toBe('computer')
    expect(milibotToolName('Bash')).toBeNull()
  })

  it('parses streamed tool input, skipping sub-agent events', () => {
    const event = (e: unknown, parent: string | null = null) =>
      parseStreamJsonLine(JSON.stringify({ type: 'stream_event', event: e, parent_tool_use_id: parent }))
    expect(
      event({
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'mcp__milibot__design_write_frame',
          input: {},
        },
      }),
    ).toEqual({ type: 'tool_input_start', index: 1, id: 'toolu_1', name: 'mcp__milibot__design_write_frame' })
    expect(
      event({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"de' },
      }),
    ).toEqual({ type: 'tool_input_delta', index: 1, partialJson: '{"de' })
    expect(event({ type: 'content_block_stop', index: 1 })).toEqual({ type: 'tool_input_stop', index: 1 })
    expect(
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ).toMatchObject({ type: 'other' })
    expect(
      event(
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{' } },
        'toolu_task',
      ),
    ).toMatchObject({ type: 'other' })
  })
})
