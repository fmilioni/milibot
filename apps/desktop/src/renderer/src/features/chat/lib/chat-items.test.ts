import type { Message } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { buildChatItems, firstUnreadIndex } from './chat-items'

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

describe('chat items', () => {
  const day1 = new Date(2026, 8, 25, 10, 0).getTime()
  const day2 = new Date(2026, 8, 26, 9, 0).getTime()
  const thread = [
    message({ id: 'm1', createdAt: day1 }),
    message({ id: 'm2', createdAt: day2, authorType: 'user', authorBotId: null }),
    message({ id: 'm3', createdAt: day2 + 1000 }),
    message({ id: 'm4', createdAt: day2 + 2000 }),
  ]

  it('inserts day dividers and the "New" divider before the first unread message', () => {
    const items = buildChatItems(thread, 2)
    expect(items.map((i) => (i.kind === 'message' ? i.message.id : i.kind))).toEqual([
      'day',
      'm1',
      'day',
      'm2',
      'unread',
      'm3',
      'm4',
    ])
  })

  it('groups consecutive messages of the same author', () => {
    const items = buildChatItems(thread, 0).filter((i) => i.kind === 'message')
    expect(items.map((i) => i.kind === 'message' && i.continued)).toEqual([false, false, false, true])
  })

  it('counts only messages from others as unread', () => {
    expect(firstUnreadIndex(thread, 3)).toBe(0)
    expect(firstUnreadIndex(thread, 0)).toBe(-1)
  })
})
