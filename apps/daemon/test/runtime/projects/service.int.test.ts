import type { DefaultAgentHost } from '@milibot/agent'
import type { CompletionRequest } from '@milibot/agent/llm'
import type { FakeStep } from '@milibot/agent/testing'
import type { ConversationSummary, Message, Project, WorkspaceEvent } from '@milibot/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../../src/db/sqlite'
import type { WorkspaceRuntime } from '../../../src/runtime/runtime'
import { bootRuntime, type RuntimeHarness, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'

let h: RuntimeHarness
let db: Db
let runtime: WorkspaceRuntime
let host: DefaultAgentHost
let events: WorkspaceEvent[]
/** Steps of the turn answering the user message that contains the key (tool-less calls just get text). */
let scenario: Record<string, FakeStep[]>
let chiefId: string
let chiefDm: string

const dir = useTempDir('projects')
afterEach(stopRuntimes)

beforeEach(async () => {
  scenario = {}
  h = await bootRuntime({ dir: dir(), vm: false, script: (request) => step(request) })
  ;({ db, runtime, host, events, botId: chiefId, dm: chiefDm } = h)
})

function step(request: CompletionRequest): FakeStep {
  if (!request.tools.length) return { text: 'Summary.' }
  const messages = request.messages
  let last = messages.length - 1
  while (last >= 0 && messages[last]?.role !== 'user') last--
  const text = (messages[last]?.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n')
  const done = messages.slice(last).filter((m) => m.role === 'tool').length
  const key = Object.keys(scenario).find((k) => text.includes(k))
  return (key ? scenario[key]?.[done] : undefined) ?? { text: 'Ok.' }
}

const call: RuntimeHarness['call'] = (...args) => h.call(...args)

async function say(conversationId: string, content: string) {
  await call<Message>('postMessage', { conversationId }, { content })
  await host.idle()
}

function toolResult(name: string, nth = 0): string {
  const rows = db
    .prepare('SELECT result_json FROM tool_calls WHERE tool_name = ? ORDER BY started_at')
    .all(name) as Array<{ result_json: string | null }>
  return (JSON.parse(rows[nth]?.result_json ?? '{}') as { text?: string }).text ?? ''
}

describe('projects (fake LLM, no VM)', () => {
  it('a bot creates a project, makes it current and writes into it; other conversations see it only on request', async () => {
    scenario['new store'] = [
      { toolCalls: [{ name: 'project_create', arguments: { name: 'Store', description: 'E-commerce' } }] },
      { toolCalls: [{ name: 'project_set_current', arguments: { project: 'Store' } }] },
      {
        toolCalls: [
          {
            name: 'knowledge_write',
            arguments: { title: 'Store deploy', content: '# Deploy\nThe store deploy uses docker compose.' },
          },
        ],
      },
      { text: 'I created the Store project.' },
    ]
    await say(chiefDm, "Let's start the new store")
    const [project] = await call<Project[]>('listProjects', {}, undefined, {})
    expect(project).toMatchObject({ name: 'Store', slug: 'store', createdByBotId: chiefId })
    const dm = await call<ConversationSummary>('getConversation', { conversationId: chiefDm })
    expect(dm.projectId).toBe(project?.id)
    const line = runtime.store.messages
      .list(chiefDm, { limit: 100 })
      .messages.find((m) => m.payload?.type === 'system' && m.payload.event === 'project_changed')
    expect(line?.payload).toMatchObject({ params: { projectName: 'Store', actor: 'bot' } })
    const doc = runtime.services.knowledge.docs.all().find((d) => d.title === 'Store deploy')
    expect(doc?.project_id).toBe(project?.id)

    const { conversation: anaDm } = await call<{
      bot: { id: string }
      conversation: { id: string }
    }>('createBot', {}, { name: 'Ana', label: 'Dev' })
    await host.idle()
    scenario['Which documents'] = [{ toolCalls: [{ name: 'knowledge_list', arguments: {} }] }]
    scenario['all projects'] = [{ toolCalls: [{ name: 'knowledge_list', arguments: { project: 'all' } }] }]
    await say(anaDm.id, 'Which documents do you have?')
    expect(toolResult('knowledge_list', 0)).not.toContain('Store deploy')
    await say(anaDm.id, 'And across all projects?')
    expect(toolResult('knowledge_list', 1)).toContain('Store deploy')
    expect(toolResult('knowledge_list', 1)).toContain('project Store')

    await call('setConversationProject', { conversationId: anaDm.id }, { projectId: project?.id })
    scenario['And now'] = [{ toolCalls: [{ name: 'knowledge_list', arguments: {} }] }]
    await say(anaDm.id, 'And now?')
    expect(toolResult('knowledge_list', 2)).toContain('Store deploy')
    expect(events.some((e) => e.type === 'project.updated')).toBe(true)
    expect(
      events.some(
        (e) =>
          e.type === 'conversation.updated' &&
          e.payload.conversation.id === anaDm.id &&
          e.payload.conversation.projectId,
      ),
    ).toBe(true)
  })

  it('deleting a project makes its documents, notes and conversations general', async () => {
    const project = await call<Project>('createProject', {}, { name: 'Trip' })
    await call('setConversationProject', { conversationId: chiefDm }, { projectId: project.id })
    await call('createWorkspaceMemory', {}, { content: 'Hotel in Kyoto', projectId: project.id })
    await call('deleteProject', { projectId: project.id })
    const dm = await call<ConversationSummary>('getConversation', { conversationId: chiefDm })
    expect(dm.projectId).toBeNull()
    const notes = await call<Array<{ content: string; projectId: string | null }>>('listWorkspaceMemories')
    expect(notes).toEqual([expect.objectContaining({ content: 'Hotel in Kyoto', projectId: null })])
    expect(events.some((e) => e.type === 'project.deleted')).toBe(true)
  })
})
