import type { ScreenControl } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { releaseUserControl, releaseWorkspaces } from './control-release'

type Call = { name: string; params: Record<string, string>; body?: unknown }

function fakeClient(control: Record<string, ScreenControl>, options: { hangOn?: string } = {}) {
  const calls: Call[] = []
  const client = {
    call: (async (name: string, args: { params: Record<string, string>; body?: unknown }) => {
      calls.push({ name, params: args.params, body: args.body })
      const key = `${args.params.workspaceId}:${args.params.botId}`
      if (options.hangOn === key) return new Promise(() => undefined)
      if (name === 'listBots')
        return Object.keys(control)
          .filter((k) => k.startsWith(`${args.params.workspaceId}:`))
          .map((k) => ({ id: k.split(':')[1] }))
      if (name === 'getBotDisplay') return { control: control[key] ?? 'idle' }
      if (name === 'controlBot') {
        control[key] = 'idle'
        return { ok: true, paused: false, control: 'idle' }
      }
      throw new Error(`unexpected ${name}`)
    }) as never,
  }
  return { client, calls, control }
}

describe('releaseUserControl', () => {
  it('releases only a screen the user holds', async () => {
    const { client, calls } = fakeClient({ 'ws1:b1': 'user', 'ws1:b2': 'bot' })
    expect(await releaseUserControl(client, 'ws1', 'b1')).toBe(true)
    expect(await releaseUserControl(client, 'ws1', 'b2')).toBe(false)
    expect(calls.filter((c) => c.name === 'controlBot')).toEqual([
      { name: 'controlBot', params: { workspaceId: 'ws1', botId: 'b1' }, body: { action: 'release' } },
    ])
  })
})

describe('releaseWorkspaces', () => {
  it('releases every held screen of the open workspaces', async () => {
    const { client, control } = fakeClient({
      'ws1:b1': 'user',
      'ws1:b2': 'bot',
      'ws2:b3': 'user',
      'ws3:b4': 'user',
    })
    await releaseWorkspaces(client, ['ws1', 'ws2'], 1000)
    expect(control).toEqual({ 'ws1:b1': 'idle', 'ws1:b2': 'bot', 'ws2:b3': 'idle', 'ws3:b4': 'user' })
  })

  it('gives up after the timeout', async () => {
    const { client } = fakeClient({ 'ws1:b1': 'user' }, { hangOn: 'ws1:b1' })
    const started = Date.now()
    await releaseWorkspaces(client, ['ws1'], 30)
    expect(Date.now() - started).toBeLessThan(1000)
  })
})
