import type { ToolExecContext } from '@milibot/agent'
import type { ToolCall } from '@milibot/agent/llm'
import { toolError, ToolInputError, toolText } from '@milibot/agent/tools'
import type { Bot } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { runToolSwitch, type ToolHandlers, ToolSwitch } from '../../../src/runtime/tools-core'

const text = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((c) => c.text ?? '').join('')

function ctx(signal = new AbortController().signal): ToolExecContext {
  return { bot: { id: 'bot_1' } as Bot, conversationId: null, turnId: null, signal }
}

const call = (name: string, args: unknown): ToolCall => ({ id: 't1', name, arguments: args }) as ToolCall

class Oops extends Error {}

class EchoTools extends ToolSwitch {
  readonly name = 'echo'
  protected readonly handlers: ToolHandlers = {
    echo: (_ctx, a) => toolText(String(a.value)),
    oops: () => {
      throw new Oops('broken pipe')
    },
  }

  protected override mapError(err: unknown) {
    return err instanceof Oops ? toolError(`Echo failed: ${err.message}`) : undefined
  }
}

describe('runToolSwitch', () => {
  it('runs the handler of a call with its parsed arguments', async () => {
    const table: ToolHandlers = {
      echo: (_ctx, a) => toolText(String(a.value)),
      fail: () => {
        throw new ToolInputError('"value" is required')
      },
    }
    expect(text(await runToolSwitch(ctx(), call('echo', { value: 'hi' }), table))).toBe('hi')
    expect(text(await runToolSwitch(ctx(), call('fail', {}), table))).toBe(
      'Invalid input: "value" is required',
    )
    expect(text(await runToolSwitch(ctx(), call('echo', { __invalidJson: '{nope' }), table))).toMatch(
      /^Invalid input: arguments are not valid JSON/,
    )
    expect(text(await runToolSwitch(ctx(), call('toString', {}), table))).toBe('Unknown tool "toString"')
  })

  it("maps a family's own errors before the common ones and rethrows once the turn stopped", async () => {
    const tools = new EchoTools()
    expect(tools.handles('echo')).toBe(true)
    expect(tools.handles('toString')).toBe(false)
    expect(text(await tools.execute(ctx(), call('oops', {})))).toBe('Echo failed: broken pipe')
    const stopped = new AbortController()
    stopped.abort()
    await expect(tools.execute(ctx(stopped.signal), call('oops', {}))).rejects.toThrow('broken pipe')
  })
})
