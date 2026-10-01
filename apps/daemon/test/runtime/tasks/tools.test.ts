import type { ToolExecContext } from '@milibot/agent'
import type { Bot, Message, TaskPayload } from '@milibot/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import { TaskCardService } from '../../../src/runtime/tasks/service'
import { TaskCardTools } from '../../../src/runtime/tasks/tools'
import { WorkspaceStore } from '../../../src/runtime/workspace-store'
import { openWorkspaceDb } from '../../../src/workspace-db/open'

let store: WorkspaceStore
let tools: TaskCardTools
let nina: Bot
let dm: string
let pullRequests: Array<{ conversationId: string; url: string | null; status: string }>

beforeEach(() => {
  store = new WorkspaceStore(openWorkspaceDb(':memory:'), () => Date.now())
  nina = store.bots.create({ name: 'Nina', label: 'Dev', systemPrompt: '' })
  dm = store.conversations.create({ type: 'direct', botIds: [nina.id] }).id
  pullRequests = []
  const service = new TaskCardService({
    messages: store.messages,
    getBot: (id) => (id === nina.id ? nina : null),
    directConversationId: () => dm,
    appendMessage: (message) => store.messages.create(message),
    updateMessage: (id, patch) => {
      store.messages.update(id, patch)
      return store.messages.get(id)
    },
    exec: async () => null,
    onPullRequest: (conversationId, payload) =>
      pullRequests.push({ conversationId, url: payload.url, status: payload.status }),
  })
  tools = new TaskCardTools({ cards: service })
})

const cards = (): Array<Message & { payload: TaskPayload }> =>
  store.messages.list(dm, { limit: 50 }).messages.filter((m) => m.payload?.type === 'task') as Array<
    Message & { payload: TaskPayload }
  >

const ctx = (): ToolExecContext => ({
  bot: nina,
  conversationId: dm,
  turnId: null,
  signal: new AbortController().signal,
})

describe('report_task', () => {
  it('posts a card and updates it in place by url', async () => {
    const call = (status: string) =>
      tools.execute(ctx(), {
        id: 'c',
        name: 'report_task',
        arguments: { title: 'API deploy', status, url: 'https://github.com/acme/api/pull/8' },
      })
    expect((await call('review')).content[0]).toEqual({ type: 'text', text: 'Posted the task card.' })
    expect((await call('done')).content[0]).toMatchObject({ text: 'Updated the task card (done).' })
    const [card, ...rest] = cards()
    expect(rest).toHaveLength(0)
    expect(card?.payload).toEqual({
      type: 'task',
      title: 'API deploy',
      status: 'done',
      url: 'https://github.com/acme/api/pull/8',
      repo: 'acme/api',
      prNumber: 8,
      branch: null,
      botId: nina.id,
    })
    expect(card?.authorBotId).toBe(nina.id)
    expect(pullRequests).toEqual([
      { conversationId: dm, url: 'https://github.com/acme/api/pull/8', status: 'review' },
      { conversationId: dm, url: 'https://github.com/acme/api/pull/8', status: 'done' },
    ])
  })

  it('validates status and url; cards without a url are not merged', async () => {
    const run = (args: Record<string, unknown>) =>
      tools.execute(ctx(), { id: 'c', name: 'report_task', arguments: args })
    expect((await run({ title: 'x', status: 'late' })).isError).toBe(true)
    expect((await run({ title: '', status: 'open' })).isError).toBe(true)
    expect((await run({ title: 'x', status: 'open', url: 'javascript:alert(1)' })).isError).toBe(true)
    await run({ title: 'Report', status: 'open' })
    await run({ title: 'Report', status: 'done' })
    expect(cards()).toHaveLength(2)
    expect(pullRequests).toEqual([])
  })
})
