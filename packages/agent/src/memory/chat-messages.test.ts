import type { Bot, Message } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import type { ChatMessage } from '../llm/messages'
import { messageToChat, OMITTED_SCREENSHOT, pruneScreenshots } from './chat-messages'

const bot = { id: 'bot_1', name: 'Nina' } as Bot

function userMessage(attachments: Array<{ id: string; path: string; image: boolean }>): Message {
  return {
    id: 'msg_1',
    conversationId: 'cnv_1',
    authorType: 'user',
    authorBotId: null,
    kind: 'text',
    content: `look\n\n[Attached files, saved in the VM]\n${attachments.map((a) => `- ${a.path}`).join('\n')}`,
    payload: {
      type: 'user_message',
      text: 'look',
      attachments: attachments.map((a) => ({
        id: a.id,
        name: a.path.split('/').pop() as string,
        size: 10,
        mimeType: a.image ? 'image/png' : 'text/plain',
        path: a.path,
        status: 'queued',
        image: a.image ? { sha256: `sha-${a.id}`, mediaType: 'image/png', width: 100, height: 50 } : null,
      })),
    },
    createdAt: 1,
  }
}

describe('attachments in the model context', () => {
  it('sends the paths as text and PNG/JPEG attachments as images', () => {
    const chat = messageToChat(
      userMessage([
        { id: 'a', path: '/workspace/uploads/nina/2026-09-26/screen.png', image: true },
        { id: 'b', path: '/workspace/uploads/nina/2026-09-26/data.csv', image: false },
      ]),
      bot,
      new Map(),
    )
    expect(chat?.role).toBe('user')
    expect(chat?.content[0]).toMatchObject({ type: 'text' })
    expect((chat?.content[0] as { text: string }).text).toContain(
      '/workspace/uploads/nina/2026-09-26/data.csv',
    )
    expect(chat?.content.slice(1)).toEqual([
      expect.objectContaining({ type: 'image', sha256: 'sha-a', width: 100, height: 50 }),
    ])
  })

  it('counts attached images in the screenshot budget and leaves the path when pruned', () => {
    const attached = messageToChat(
      userMessage([
        { id: 'a', path: '/workspace/uploads/nina/d/1.png', image: true },
        { id: 'b', path: '/workspace/uploads/nina/d/2.png', image: true },
      ]),
      bot,
      new Map(),
    ) as ChatMessage
    const screenshot: ChatMessage = {
      role: 'tool',
      toolCallId: 't',
      toolName: 'computer',
      content: [{ type: 'image', sha256: 's', mediaType: 'image/png', width: 1280, height: 800 }],
    }
    const messages = [attached, screenshot]
    pruneScreenshots(messages)
    const images = messages.flatMap((m) => m.content).filter((p) => p.type === 'image')
    expect(images).toHaveLength(2)
    expect(attached.content[1]).toEqual({
      type: 'text',
      text: '[image /workspace/uploads/nina/d/1.png omitted to save context; read the file if you need it again]',
    })
    const older: ChatMessage = { ...screenshot, content: [...screenshot.content] }
    pruneScreenshots([older, attached, screenshot])
    expect(older.content[0]).toEqual({ type: 'text', text: OMITTED_SCREENSHOT })
  })
})
