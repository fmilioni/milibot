import type { LlmCallRecord } from '@milibot/agent'
import { LLM_CALL_RUNNING } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { DebugStore } from '../../../src/runtime/observability/debug'
import { LlmCallStore } from '../../../src/runtime/observability/llm-calls'
import { WorkspaceStore } from '../../../src/runtime/workspace-store'
import { openWorkspaceDb } from '../../../src/workspace-db/open'

function setup() {
  const db = openWorkspaceDb(':memory:')
  let clock = 1_000
  const now = () => clock
  const store = new WorkspaceStore(db, now)
  const bot = store.bots.create({ name: 'Ana' })
  const record = (over: Partial<LlmCallRecord>): LlmCallRecord => ({
    botId: bot.id,
    conversationId: null,
    turnId: 'turn_1',
    purpose: 'turn',
    providerId: null,
    providerType: 'claude_code',
    model: 'claude-sonnet-5',
    request: { input: 'hi' },
    response: { requests: 1 },
    usage: {
      inputTokens: 10,
      cachedReadTokens: 1000,
      cacheWriteTokens: 0,
      outputTokens: 20,
      reasoningTokens: 0,
      costUsd: 0.01,
      costSource: 'computed',
    },
    contextComposition: null,
    stopReason: LLM_CALL_RUNNING,
    generationId: null,
    latencyMs: 300,
    error: null,
    ...over,
  })
  return { db, store, bot, llmCalls: new LlmCallStore(db, now), record, at: (ms: number) => (clock = ms) }
}

describe('LlmCallStore', () => {
  it('replaces a running call with its progress and then its result, under the same id', () => {
    const { llmCalls, record, at } = setup()
    const id = llmCalls.insert(record({}))
    at(2_000)
    llmCalls.update(
      id,
      record({ response: { requests: 2 }, usage: { ...record({}).usage, outputTokens: 40 } }),
    )
    expect(llmCalls.get(id)).toMatchObject({
      stopReason: LLM_CALL_RUNNING,
      outputTokens: 40,
      createdAt: 2_000,
    })

    at(5_000)
    const models = [
      {
        model: 'claude-sonnet-5',
        inputTokens: 20,
        cachedReadTokens: 2000,
        cacheWriteTokens: 0,
        outputTokens: 60,
        reasoningTokens: 0,
        costUsd: 0.03,
        webSearchRequests: 0,
      },
    ]
    llmCalls.update(
      id,
      record({
        stopReason: 'success',
        usage: { ...models[0], costUsd: 0.03, costSource: 'provider' } as LlmCallRecord['usage'],
        models,
        latencyMs: 4_000,
      }),
    )
    const done = llmCalls.get(id)
    expect(done).toMatchObject({
      stopReason: 'success',
      costUsd: 0.03,
      costSource: 'provider',
      latencyMs: 4_000,
      createdAt: 5_000,
    })
    expect(done.models).toHaveLength(1)
    expect(llmCalls.usageSince(0).costUsd).toBeCloseTo(0.03)
  })

  it('refuses to update a call that does not exist', () => {
    const { llmCalls, record } = setup()
    expect(() => llmCalls.update('llmCall_missing', record({}))).toThrow()
  })

  it('ends as interrupted the calls a stopped daemon left running', () => {
    const { llmCalls, record } = setup()
    const running = llmCalls.insert(record({}))
    const done = llmCalls.insert(record({ stopReason: 'success' }))
    expect(llmCalls.closeRunning()).toBe(1)
    expect(llmCalls.get(running).stopReason).toBe('interrupted')
    expect(llmCalls.get(done).stopReason).toBe('success')
  })

  it('keeps the instruction files with the request, on insert and update, and the debug view reads them', () => {
    const { db, store, bot, llmCalls, record, at } = setup()
    const conversation = store.conversations.create({ type: 'direct', botIds: [bot.id] })
    const files = [
      { path: '/workspace/app/CLAUDE.md', bytes: 120, truncated: false, source: 'engine' as const },
      { path: '/workspace/app/sub/AGENTS.md', bytes: 99_000, truncated: true, source: 'injected' as const },
    ]
    const id = llmCalls.insert(
      record({ conversationId: conversation.id, instructionFiles: files.slice(0, 1) }),
    )
    expect(llmCalls.get(id).request).toEqual({ input: 'hi', instructionFiles: files.slice(0, 1) })
    at(2_000)
    const composition = {
      systemPrompt: 10,
      longTermMemory: 0,
      summaries: 0,
      retrieved: 0,
      recentTail: 0,
      tools: 0,
    }
    llmCalls.update(
      id,
      record({
        conversationId: conversation.id,
        stopReason: 'success',
        contextComposition: composition,
        instructionFiles: files,
      }),
    )
    const native = llmCalls.insert(record({ conversationId: null, request: null, instructionFiles: files }))
    expect(llmCalls.get(native).request).toEqual({ request: null, instructionFiles: files })
    const [latest] = new DebugStore(db).conversation(conversation.id).latestComposition
    expect(latest?.instructionFiles).toEqual(files)
  })
})
