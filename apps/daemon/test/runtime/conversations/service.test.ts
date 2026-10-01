import type { WorkspaceEvent } from '@milibot/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import { ConversationService } from '../../../src/runtime/conversations/service'
import { WorkspaceStore } from '../../../src/runtime/workspace-store'
import { openWorkspaceDb } from '../../../src/workspace-db/open'

let store: WorkspaceStore
let events: WorkspaceEvent[]
let handlers: ReturnType<ConversationService['handlers']>

const workspaceId = 'ws_test'

beforeEach(() => {
  store = new WorkspaceStore(openWorkspaceDb(':memory:'), () => Date.now())
  events = []
  handlers = new ConversationService({
    store,
    emit: (e) => events.push(e),
    host: { onMessageCreated: () => undefined },
    attachments: { claim: () => [], bind: () => undefined, settle: async () => undefined },
    userRequests: { answerFromChat: () => false },
    workSessions: { onUserMessage: () => undefined },
  }).handlers()
})

describe('conversations', () => {
  it('renames and deletes groups but refuses direct conversations', async () => {
    const bot = store.bots.create({ name: 'A' })
    const bot2 = store.bots.create({ name: 'B' })
    const group = store.conversations.create({ type: 'group', botIds: [bot.id, bot2.id] })
    const direct = store.conversations.create({
      type: 'direct',
      botIds: [store.bots.create({ name: 'C' }).id],
    })

    const renamed = await handlers.updateConversation({
      params: { workspaceId, conversationId: group.id },
      query: undefined,
      body: { title: 'Squad' },
    })
    expect(renamed.title).toBe('Squad')
    expect(events.at(-1)).toMatchObject({
      type: 'conversation.updated',
      payload: { conversation: { title: 'Squad' } },
    })
    expect(() =>
      handlers.updateConversation({
        params: { workspaceId, conversationId: direct.id },
        query: undefined,
        body: { title: 'x' },
      }),
    ).toThrow()

    await handlers.deleteConversation({
      params: { workspaceId, conversationId: group.id },
      query: undefined,
      body: undefined,
    })
    expect(store.conversations.list().map((c) => c.id)).not.toContain(group.id)
    expect(events.at(-1)).toEqual({ type: 'conversation.deleted', payload: { conversationId: group.id } })
  })
})
