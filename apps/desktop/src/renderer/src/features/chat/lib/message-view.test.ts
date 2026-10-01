import type { Message } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { toMessageView } from './message-view'

function message(partial: Partial<Message> & { id: string }): Message {
  return {
    conversationId: 'c1',
    authorType: 'bot',
    authorBotId: 'b1',
    kind: 'text',
    content: 'x',
    payload: null,
    createdAt: new Date(2026, 8, 26, 14, 0).getTime(),
    ...partial,
  }
}

describe('toMessageView', () => {
  it('parses the runtime payloads and falls back to text', () => {
    expect(
      toMessageView(message({ id: 'a', payload: { type: 'text', streaming: true, turnId: null } })),
    ).toEqual({
      type: 'text',
      streaming: true,
      attachments: [],
      text: null,
    })
    const activity = toMessageView(
      message({
        id: 'b',
        kind: 'activity',
        payload: { type: 'activity', turnId: 't', status: 'running', steps: [] },
      }),
    )
    expect(activity.type).toBe('activity')
    expect(
      toMessageView(message({ id: 'c', kind: 'card', payload: { type: 'mystery' } as never })).type,
    ).toBe('text')
    expect(
      toMessageView(
        message({
          id: 'd',
          kind: 'card',
          payload: {
            type: 'task',
            title: 'PR',
            status: 'review',
            url: 'https://github.com/o/r/pull/1',
            repo: 'o/r',
            prNumber: 1,
            branch: null,
            botId: null,
          },
        }),
      ).type,
    ).toBe('task')
    expect(
      toMessageView(message({ id: 'e', kind: 'system_event', authorType: 'system', authorBotId: null })),
    ).toEqual({ type: 'system', payload: null })
  })

  it('keeps the images a bot text mentions', () => {
    const image = {
      id: 'attachment_1',
      name: 'preview.png',
      size: 120,
      mimeType: 'image/png',
      path: '/workspace/app/preview.png',
      status: 'ready' as const,
      image: { sha256: 'a'.repeat(64), mediaType: 'image/png' as const, width: 20, height: 10 },
    }
    expect(
      toMessageView(
        message({
          id: 'f',
          content: 'The preview is at `/workspace/app/preview.png`',
          payload: { type: 'text', streaming: false, turnId: 't', attachments: [image] },
        }),
      ),
    ).toEqual({ type: 'text', streaming: false, attachments: [image], text: null })
    expect(toMessageView(message({ id: 'g', payload: null }))).toEqual({
      type: 'text',
      streaming: false,
      attachments: [],
      text: null,
    })
    expect(
      toMessageView(
        message({
          id: 'h',
          content:
            'Here it is\n\n[Shared file, saved in the VM]\n- /workspace/app/preview.png (image/png, 1 KB)',
          payload: { type: 'text', streaming: false, turnId: 't', attachments: [image], text: 'Here it is' },
        }),
      ),
    ).toEqual({ type: 'text', streaming: false, attachments: [image], text: 'Here it is' })
  })
})
