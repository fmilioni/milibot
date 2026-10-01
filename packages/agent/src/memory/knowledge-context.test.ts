import { describe, expect, it } from 'vitest'

import { DefaultAgentHost } from '../host/agent-host'
import { FakeProvider } from '../llm/fake'
import type { CompletionRequest } from '../llm/provider'
import { makeBot, TestEnv } from '../test-support/env'
import { InMemoryMemory } from '../test-support/in-memory'
import { buildMemoryBootstrap } from './bootstrap'
import { addTurnKnowledge, buildContext, contextComposition } from './context-builder'
import { compositionTotal } from './tokens'
import { executeMemoryTool, MAX_NOTE_CHARS } from './tools'
import { DEFAULT_MEMORY_CONFIG } from './types'

const CATALOG = '# Knowledge base\n3 documents …\nPinned documents:\n- Contract (pdf, 12 p.) — Office lease.'
const TURN =
  '[Milibot knowledge] Documents that may be relevant to the message below:\n- Contract (pdf, kdoc_1)'

function texts(request: CompletionRequest | undefined, index: number): string[] {
  return (request?.messages[index]?.content ?? []).map((p) => (p.type === 'text' ? p.text : ''))
}

describe('knowledge in the context', () => {
  it('puts the catalog with the workspace memory and the turn block in the latest input', () => {
    const bot = makeBot()
    const messages = [
      {
        id: 'm1',
        conversationId: 'c',
        authorType: 'user' as const,
        authorBotId: null,
        kind: 'text' as const,
        content: 'When is the rent due?',
        payload: null,
        turnId: null,
        createdAt: 1,
      },
    ]
    const memory = new InMemoryMemory(
      () => messages,
      () => true,
      () => 2,
    )
    memory.saveNote({ botId: bot.id, content: 'The user lives in Recife.', pinned: true, scope: 'workspace' })
    const built = buildContext({
      bot,
      conversationId: 'c',
      systemPrompt: 'SYSTEM',
      tools: [],
      memory,
      botsById: new Map([[bot.id, bot]]),
      config: DEFAULT_MEMORY_CONFIG,
      knowledgeCatalog: CATALOG,
    })
    const system = built.system.content.map((p) => (p.type === 'text' ? p.text : ''))
    expect(system[1]).toMatch(/^# Workspace memory[\s\S]*The user lives in Recife\.\n\n# Knowledge base/)
    expect(built.input).toBe('When is the rent due?')
    addTurnKnowledge(built, TURN)
    const last = built.conversation.at(-1)
    expect(last?.content.map((p) => (p.type === 'text' ? p.text : ''))).toEqual([
      TURN,
      'When is the rent due?',
    ])
    const composition = contextComposition(built, built.conversation)
    expect(composition.knowledge).toBe(Math.ceil(CATALOG.length / 3.5) + Math.ceil(TURN.length / 3.5))
    expect(composition.longTermMemory).toBeLessThan(Math.ceil(system[1]!.length / 3.5))
  })

  it('native turns get the catalog in the system part and the suggestions before the input', async () => {
    const provider = new FakeProvider({ script: () => ({ text: 'Dia 5.' }) })
    const env = new TestEnv(provider)
    const queries: string[] = []
    env.knowledge = {
      catalog: () => CATALOG,
      forTurn: async (_bot, query) => {
        queries.push(query)
        return TURN
      },
    }
    const bot = makeBot()
    const conversation = env.addBot(bot)
    const host = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host.start(env)
    host.onMessageCreated(env.userMessage(conversation.id, 'When is the rent due?'))
    await host.idle(bot.id)
    const request = provider.requests[0]
    expect(texts(request, 0).join('\n')).toContain(CATALOG)
    expect(texts(request, request!.messages.length - 1)).toEqual([TURN, 'When is the rent due?'])
    expect(queries).toEqual(['When is the rent due?'])
    const call = env.llmCalls.find((c) => c.purpose === 'turn')
    expect(call?.contextComposition?.knowledge).toBeGreaterThan(0)
    expect(compositionTotal(call!.contextComposition!)).toBe(call?.usage.inputTokens)
    await host.stop()
  })

  it("native turns get the conversation's project block and its documents for the turn", async () => {
    const provider = new FakeProvider({ script: () => ({ text: 'Ok.' }) })
    const env = new TestEnv(provider)
    const projectIds: Array<string | null | undefined> = []
    env.knowledge = {
      catalog: () => CATALOG,
      forTurn: async (_bot, _query, _signal, projectId) => {
        projectIds.push(projectId)
        return ''
      },
    }
    env.projects = {
      resolve: () => ({ project: { id: 'prj_1', name: 'Store' } }),
      block: () => '# Current project: Store\nE-commerce.',
    }
    const bot = makeBot()
    const conversation = env.addBot(bot)
    const host = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host.start(env)
    host.onMessageCreated(env.userMessage(conversation.id, 'hi'))
    await host.idle(bot.id)
    expect(texts(provider.requests[0], 0).join('\n')).not.toContain('E-commerce')
    conversation.projectId = 'prj_1'
    host.onMessageCreated(env.userMessage(conversation.id, 'what about the store?'))
    await host.idle(bot.id)
    const system = texts(provider.requests[1], 0)
    expect(system[1]).toMatch(/# Knowledge base[\s\S]*\n\n# Current project: Store\nE-commerce\.$/)
    expect(projectIds).toEqual([null, 'prj_1'])
    await host.stop()
  })

  it('leaves knowledge out of the context while the knowledge tools are off for the bot', async () => {
    const provider = new FakeProvider({ script: () => ({ text: 'Ok.' }) })
    const env = new TestEnv(provider)
    const queries: string[] = []
    env.knowledge = {
      catalog: () => CATALOG,
      forTurn: async (_bot, query) => {
        queries.push(query)
        return TURN
      },
    }
    const blockOptions: unknown[] = []
    env.projects = {
      resolve: () => ({ project: { id: 'prj_1', name: 'Store' } }),
      block: (_bot, _id, options) => {
        blockOptions.push(options)
        return '# Current project: Store'
      },
    }
    Object.assign(env, { skillContext: () => ({ catalog: '', families: new Set(['browser', 'computer']) }) })
    const bot = makeBot()
    const conversation = env.addBot(bot)
    conversation.projectId = 'prj_1'
    const host = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host.start(env)
    host.onMessageCreated(env.userMessage(conversation.id, 'When is the rent due?'))
    await host.idle(bot.id)
    const request = provider.requests[0]
    const all = (request?.messages ?? []).flatMap((_, i) => texts(request, i)).join('\n')
    expect(all).not.toContain('# Knowledge base')
    expect(all).not.toContain('[Milibot knowledge]')
    expect(all).toContain('# Current project: Store')
    expect(queries).toEqual([])
    expect(blockOptions).toEqual([{ knowledge: false }])
    await host.stop()
  })

  it('memory_save scope "project" saves into the current project, and needs one', () => {
    const bot = makeBot()
    const memory = new InMemoryMemory(
      () => [],
      () => true,
      () => 1,
    )
    const base = { bot, conversationId: 'c', botsById: new Map([[bot.id, bot]]), memory }
    const save = (projectId: string | null, note: string) =>
      executeMemoryTool(
        { ...base, projectId },
        { id: note, name: 'memory_save', arguments: { note, scope: 'project' } },
      )
    expect(save(null, 'The store deploys on Fridays.').isError).toBe(true)
    expect(save('prj_1', 'The store deploys on Fridays.').isError).toBeUndefined()
    expect(memory.projectNotes('prj_1').map((n) => n.content)).toEqual(['The store deploys on Fridays.'])
    expect(memory.workspaceNotes()).toHaveLength(0)
  })

  it('a failing knowledge backend never breaks the turn', async () => {
    const provider = new FakeProvider({ script: () => ({ text: 'Ok.' }) })
    const env = new TestEnv(provider)
    env.knowledge = {
      catalog: () => {
        throw new Error('db locked')
      },
      forTurn: async () => {
        throw new Error('model gone')
      },
    }
    const bot = makeBot()
    const conversation = env.addBot(bot)
    const host = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host.start(env)
    host.onMessageCreated(env.userMessage(conversation.id, 'hi'))
    await host.idle(bot.id)
    expect(env.messages.some((m) => m.content === 'Ok.')).toBe(true)
    await host.stop()
  })

  it('is part of the Claude Code memory bootstrap and its digest', () => {
    const bot = makeBot()
    const memory = new InMemoryMemory(
      () => [],
      () => true,
      () => 1,
    )
    const input = {
      bot,
      conversationId: 'c',
      memory,
      botsById: new Map([[bot.id, bot]]),
      config: DEFAULT_MEMORY_CONFIG,
      recap: false,
    }
    const without = buildMemoryBootstrap(input)
    const withCatalog = buildMemoryBootstrap({ ...input, knowledgeCatalog: CATALOG })
    expect(without.text).toBe('')
    expect(withCatalog.text).toContain(CATALOG)
    expect(withCatalog.digest).not.toBe(without.digest)
    expect(withCatalog.sections.longTermMemory).toBeGreaterThan(0)
  })

  it('memory_save refuses long notes and points to the knowledge base', () => {
    const bot = makeBot()
    const memory = new InMemoryMemory(
      () => [],
      () => true,
      () => 1,
    )
    const ctx = { bot, conversationId: null, botsById: new Map([[bot.id, bot]]), memory }
    const long = executeMemoryTool(ctx, {
      id: '1',
      name: 'memory_save',
      arguments: { note: 'x'.repeat(MAX_NOTE_CHARS + 1) },
    })
    expect(long.isError).toBe(true)
    expect(long.content[0]?.type === 'text' && long.content[0].text).toContain('knowledge_write')
    expect(memory.botNotes(bot.id)).toHaveLength(0)
    const ok = executeMemoryTool(ctx, {
      id: '2',
      name: 'memory_save',
      arguments: { note: 'y'.repeat(MAX_NOTE_CHARS) },
    })
    expect(ok.isError).toBeUndefined()
  })
})
