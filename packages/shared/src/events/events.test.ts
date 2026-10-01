import { describe, expect, it } from 'vitest'

import { AppEvent, WorkspaceEventEnvelope } from './events'

describe('events', () => {
  it('parses event envelopes and rejects unknown events', () => {
    const frame = {
      seq: 1,
      at: 1,
      workspaceId: 'ws_1',
      event: { type: 'bot.status', payload: { botId: 'bot_1', status: 'working' } },
    }
    expect(WorkspaceEventEnvelope.parse(frame).event.type).toBe('bot.status')
    expect(
      WorkspaceEventEnvelope.safeParse({ ...frame, event: { type: 'bot.exploded', payload: {} } }).success,
    ).toBe(false)
    expect(AppEvent.safeParse({ type: 'workspace.deleted', payload: { workspaceId: 'ws_1' } }).success).toBe(
      true,
    )
  })
})
