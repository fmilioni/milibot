import type { Message } from '@milibot/shared'

import { isAwaitingFirstDelta } from './working'

export type ChatItem =
  | { kind: 'day'; key: string; at: number }
  | { kind: 'unread'; key: string }
  | { kind: 'message'; key: string; message: Message; continued: boolean }
  | { kind: 'working'; key: string; botId: string }
  | { kind: 'paused'; key: string; botId: string }

const GROUP_WINDOW_MS = 5 * 60_000

function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/**
 * Index of the first unread message given how many messages from others are unread (the daemon
 * counts non-user messages after the last read one).
 */
export function firstUnreadIndex(messages: Message[], unreadCount: number): number {
  if (unreadCount <= 0) return -1
  let remaining = unreadCount
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as Message).authorType !== 'user') remaining--
    if (remaining === 0) return i
  }
  return -1
}

/**
 * Flattens a thread into list rows: date dividers, the "New" (unread) divider before the first unread
 * message, and messages flagged as `continued` when they follow the same author closely. Bot replies
 * that have not streamed any text yet are left out (the "working" row stands in for them).
 */
export function buildChatItems(messages: Message[], unreadCount = 0): ChatItem[] {
  const items: ChatItem[] = []
  const unreadAt = firstUnreadIndex(messages, unreadCount)
  let previous: Message | undefined
  let unreadCarried = false
  messages.forEach((message, index) => {
    if (isAwaitingFirstDelta(message)) {
      unreadCarried ||= index === unreadAt
      return
    }
    const newDay = !previous || dayKey(previous.createdAt) !== dayKey(message.createdAt)
    if (newDay) items.push({ kind: 'day', key: `day-${dayKey(message.createdAt)}`, at: message.createdAt })
    const unread = index === unreadAt || unreadCarried
    unreadCarried = false
    if (unread) items.push({ kind: 'unread', key: 'unread' })
    const continued =
      !newDay &&
      !unread &&
      previous !== undefined &&
      previous.kind !== 'system_event' &&
      message.kind !== 'system_event' &&
      message.authorType !== 'system' &&
      previous.authorType === message.authorType &&
      previous.authorBotId === message.authorBotId &&
      message.createdAt - previous.createdAt < GROUP_WINDOW_MS
    items.push({ kind: 'message', key: message.id, message, continued })
    previous = message
  })
  return items
}
