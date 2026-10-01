import type { ToolExecContext } from '@milibot/agent'
import type { Bot } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { ComputerTools } from '../../../src/runtime/computer/tools'
import { fakeGuest } from '../../support/fake-guest'

function setup() {
  const guest = fakeGuest()
  const client = guest.client('http://guest', 'fake-token')
  const blobs = { put: async () => 'sha-shot' }
  const tool = new ComputerTools({
    vm: { guest: async () => client },
    blobs,
    settleMs: 0,
  })
  const execute = tool.execute.bind(tool)
  const ctx: ToolExecContext = {
    bot: { id: 'b1', slug: 'ana', displayNum: 4 } as Bot,
    conversationId: null,
    turnId: null,
    signal: new AbortController().signal,
  }
  return { guest, execute, ctx }
}

describe('computer tool batching', () => {
  it('runs several actions in one input request and returns one screenshot at the end', async () => {
    const { guest, execute, ctx } = setup()
    const result = await execute(ctx, {
      id: 't1',
      name: 'computer',
      arguments: {
        actions: [
          { action: 'click', x: 100, y: 200 },
          { action: 'type', text: 'milibot' },
          { action: 'key', keys: 'Return' },
          { action: 'wait', ms: 500 },
        ],
        screenshot_after: true,
      },
    })
    expect(guest.state.inputs).toEqual([
      {
        display: 4,
        actions: [
          { type: 'click', x: 100, y: 200 },
          { type: 'type', text: 'milibot' },
          { type: 'key', keys: 'Return' },
          { type: 'wait', ms: 500 },
        ],
      },
    ])
    expect(guest.state.screenshots).toBe(1)
    expect(result.screenshotSha).toBe('sha-shot')
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('4 actions') })
  })

  it('rejects invalid batches before touching the screen', async () => {
    const { guest, execute, ctx } = setup()
    const run = (actions: unknown) => execute(ctx, { id: 't', name: 'computer', arguments: { actions } })
    await expect(run([{ action: 'click', x: 1, y: 1 }, { action: 'screenshot' }])).resolves.toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('actions[1]') }],
    })
    await expect(run([{ action: 'click', x: 5000, y: 1 }])).resolves.toMatchObject({ isError: true })
    await expect(run([])).resolves.toMatchObject({ isError: true })
    await expect(run(Array.from({ length: 21 }, () => ({ action: 'wait', ms: 1 })))).resolves.toMatchObject({
      isError: true,
    })
    expect(guest.state.inputs).toEqual([])
  })

  it('keeps single actions working', async () => {
    const { guest, execute, ctx } = setup()
    const result = await execute(ctx, {
      id: 't',
      name: 'computer',
      arguments: { action: 'key', keys: 'ctrl+s' },
    })
    expect(result.isError).toBeFalsy()
    expect(guest.state.inputs).toEqual([{ display: 4, actions: [{ type: 'key', keys: 'ctrl+s' }] }])
    expect(guest.state.screenshots).toBe(0)
  })
})
