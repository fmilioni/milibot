import { type Bot, estimateTokens, type Message, newId } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { toAnthropicParams } from '../llm/anthropic'
import { MemoryBlobStore } from '../llm/blobs'
import type { ChatMessage, ContentPart } from '../llm/messages'
import { toOpenAIMessages } from '../llm/openai-compatible'
import { makeBot } from '../test-support/env'
import { InMemoryMemory } from '../test-support/in-memory'
import { buildMemoryBootstrap } from './bootstrap'
import { MAX_TOOL_OUTPUT_CHARS, truncateToolContent } from './chat-messages'
import { compactConversation, selectCompactionBlock, type SummarizeRequest } from './compaction'
import { buildContext, contextComposition, RETRIEVED_HEADER } from './context-builder'
import { ftsMatchExpression, searchTerms, snippetAround } from './search'
import { calibrateComposition } from './tokens'
import { executeMemoryTool, NEAR_DUPLICATE_SIMILARITY, noteSimilarity } from './tools'
import { DEFAULT_MEMORY_CONFIG, fitMemoryConfig, type MemoryConfig, memoryConfig } from './types'

// Portuguese on purpose: a pt-BR question exercises the pt stopwords and accent folding.

const CONV = 'conversation_test'

function world(bot: Bot = makeBot()) {
  const messages: Message[] = []
  let clock = Date.UTC(2026, 8, 1)
  const now = () => (clock += 60_000)
  const memory = new InMemoryMemory(
    () => messages,
    () => true,
    now,
  )
  const add = (authorType: 'user' | 'bot', content: string, conversationId = CONV): Message => {
    const message: Message = {
      id: newId('message'),
      conversationId,
      authorType,
      authorBotId: authorType === 'bot' ? bot.id : null,
      kind: 'text',
      content,
      payload: authorType === 'bot' ? { type: 'text', streaming: false, turnId: 't' } : null,
      createdAt: now(),
    }
    messages.push(message)
    return message
  }
  /** `n` exchanges of roughly `chars` characters each. */
  const chat = (n: number, chars = 700, prefix = 'filler') => {
    for (let i = 0; i < n; i++) {
      add(
        'user',
        `${prefix} question ${i}: ${'lorem ipsum dolor '.repeat(Math.ceil(chars / 18)).slice(0, chars)}`,
      )
      add(
        'bot',
        `${prefix} answer ${i}: ${'sit amet consectetur '.repeat(Math.ceil(chars / 21)).slice(0, chars)}`,
      )
    }
  }
  return { bot, messages, memory, add, chat, botsById: new Map([[bot.id, bot]]) }
}

const config = (overrides: Partial<MemoryConfig> = {}): MemoryConfig => ({
  ...DEFAULT_MEMORY_CONFIG,
  ...overrides,
})

function textOf(parts: ContentPart[]): string {
  return parts.map((p) => (p.type === 'text' ? p.text : '[image]')).join('\n')
}

function build(w: ReturnType<typeof world>, overrides: Partial<MemoryConfig> = {}, systemPrompt = 'SYSTEM') {
  return buildContext({
    bot: w.bot,
    conversationId: CONV,
    systemPrompt,
    tools: [],
    memory: w.memory,
    botsById: w.botsById,
    config: config(overrides),
  })
}

const fakeSummarizer = () => {
  const calls: SummarizeRequest[] = []
  const summarize = async (request: SummarizeRequest) => {
    calls.push(request)
    return { text: `summary #${calls.length} (level ${request.level})`, llmCallId: `llm_${calls.length}` }
  }
  return { calls, summarize }
}

describe('search helpers', () => {
  it('extracts keyword terms without stopwords and accents, keeping numbers and dotted ids', () => {
    expect(searchTerms('Qual é o IP do servidor de produção? Era 10.4.2.19')).toEqual([
      '10.4.2.19',
      'servidor',
      'producao',
      '10',
      '19',
    ])
    expect(ftsMatchExpression(['servidores', 'ip', '10.4.2.19', 'casa'])).toBe(
      '"servidor"* OR "ip" OR "10.4.2.19" OR "casa"',
    )
    expect(ftsMatchExpression([])).toBeNull()
  })

  it('cuts a snippet around the first match', () => {
    const text = `${'a'.repeat(1000)} the dog is called Biscuit ${'b'.repeat(1000)}`
    const snippet = snippetAround(text, ['biscuit'], 120)
    expect(snippet).toContain('Biscuit')
    expect(snippet.length).toBeLessThanOrEqual(122)
  })
})

describe('buildContext', () => {
  it('orders system prompt | memory + summaries | tail, with cache breakpoints on the stable parts', () => {
    const w = world()
    w.memory.saveNote({ botId: w.bot.id, content: 'The user prefers short answers.', pinned: true })
    w.chat(2)
    w.memory.saveSummary({
      botId: w.bot.id,
      conversationId: CONV,
      level: 0,
      fromSeq: 1,
      toSeq: 2,
      content: 'The user talked about fillers.',
      tokenCount: 8,
      llmCallId: null,
      childIds: [],
    })
    w.add('user', 'what now?')
    const built = build(w)
    const [prompt, memoryPart] = built.system.content
    expect(prompt).toEqual({ type: 'text', text: 'SYSTEM', cacheBreakpoint: true })
    expect(memoryPart).toMatchObject({ type: 'text', cacheBreakpoint: true })
    const memoryText = (memoryPart as { text: string }).text
    expect(memoryText.indexOf('# Long-term memory')).toBeLessThan(
      memoryText.indexOf('# Earlier in this conversation'),
    )
    expect(memoryText).toContain('short answers')
    expect(memoryText).toContain('The user talked about fillers.')
    // Messages covered by the summary are not in the tail.
    expect(built.tailStartSeq).toBe(3)
    expect(built.conversation[0]?.role).toBe('user')
    expect(textOf(built.conversation[0]?.content ?? [])).toContain('filler question 1')
    expect(textOf(built.conversation.at(-1)?.content ?? [])).toBe('what now?')
  })

  it('keeps the tail within its budget, starting with a user message', () => {
    const w = world()
    w.chat(40, 700)
    w.add('user', 'one more thing')
    const built = build(w, { tailBudgetTokens: 3000 })
    const tokens = contextComposition(built, built.conversation).recentTail
    expect(tokens).toBeLessThanOrEqual(3000)
    expect(tokens).toBeGreaterThan(2000)
    expect(built.conversation[0]?.role).toBe('user')
    expect(textOf(built.conversation.at(-1)?.content ?? [])).toBe('one more thing')
  })

  it('fits pinned notes to the memory budget, newest first, and says how many were left out', () => {
    const w = world()
    for (let i = 0; i < 30; i++)
      w.memory.saveNote({ botId: w.bot.id, content: `note ${i}: ${'x'.repeat(200)}`, pinned: true })
    w.memory.saveNote({ botId: w.bot.id, content: 'unpinned detail', pinned: false })
    w.add('user', 'hi')
    const built = build(w, { memoryBudgetTokens: 500 })
    const text = (built.system.content[1] as { text: string }).text
    expect(estimateTokens(text)).toBeLessThanOrEqual(520)
    expect(text).toContain('note 29')
    expect(text).not.toContain('note 0:')
    expect(text).toMatch(/\d+ older pinned notes are not shown/)
    expect(text).not.toContain('unpinned detail')
  })

  it('retrieves older messages for the latest input, before it, without duplicating the tail', () => {
    const w = world()
    w.add('user', 'My dog is called Biscuit and he is 3 years old.')
    w.add('bot', 'Noted!')
    w.chat(30, 700)
    w.add('user', 'What is the name of my dog?')
    const built = build(w, { tailBudgetTokens: 2000 })
    const last = built.conversation.at(-1) as ChatMessage
    expect(last.role).toBe('user')
    expect(last.content[0]).toMatchObject({ type: 'text' })
    const retrieved = (last.content[0] as { text: string }).text
    expect(retrieved.startsWith(RETRIEVED_HEADER)).toBe(true)
    expect(retrieved).toContain('Biscuit')
    expect(textOf(last.content)).toContain('What is the name of my dog?')
    expect(built.retrieved).toHaveLength(1)

    // A match that is already in the tail is not retrieved again.
    const w2 = world()
    w2.add('user', 'My dog is called Biscuit.')
    w2.add('bot', 'Noted!')
    w2.add('user', 'What is the name of my dog?')
    expect(build(w2).retrieved).toEqual([])
  })

  it('keeps the system prefix byte-identical across turns while the tail changes', () => {
    const w = world()
    w.memory.saveNote({ botId: w.bot.id, content: 'Fixed fact.', pinned: true })
    w.add('user', 'first')
    const first = build(w)
    w.add('bot', 'answer')
    w.add('user', 'second question about something else')
    const second = build(w)
    expect(JSON.stringify(second.system)).toBe(JSON.stringify(first.system))
    // The earlier tail is a prefix of the new one (retrieval only touches the latest input).
    expect(JSON.stringify(second.conversation.slice(0, first.conversation.length))).toBe(
      JSON.stringify(first.conversation),
    )
  })

  it('calibrates the composition to the billed prompt tokens', () => {
    const w = world()
    w.add('user', 'hi')
    const built = build(w)
    const estimate = contextComposition(built, built.conversation)
    const calibrated = calibrateComposition(estimate, 1234)
    expect((Object.values(calibrated) as number[]).reduce((a, b) => a + b, 0)).toBe(1234)
    expect(calibrateComposition(estimate, 0)).toEqual(estimate)
  })
})

describe('provider cache breakpoints', () => {
  const system: ChatMessage = {
    role: 'system',
    content: [
      { type: 'text', text: 'PROMPT', cacheBreakpoint: true },
      { type: 'text', text: 'MEMORY', cacheBreakpoint: true },
    ],
  }
  const user: ChatMessage = { role: 'user', content: [{ type: 'text', text: 'hi' }] }

  it('marks each stable system part and the last block for Anthropic', () => {
    const params = toAnthropicParams({
      model: 'm',
      messages: [system, user],
      tools: [],
      blobs: new MemoryBlobStore(),
    })
    expect(params.system).toEqual([
      { type: 'text', text: 'PROMPT', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'MEMORY', cache_control: { type: 'ephemeral' } },
    ])
    expect(JSON.stringify(params.messages.at(-1))).toContain('ephemeral')
  })

  it('passes the breakpoints through OpenRouter and joins the system for other endpoints', () => {
    const cached = toOpenAIMessages([system, user], true)
    expect(cached[0]).toEqual({
      role: 'system',
      content: [
        { type: 'text', text: 'PROMPT', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'MEMORY', cache_control: { type: 'ephemeral' } },
      ],
    })
    expect(toOpenAIMessages([system, user], false)[0]).toEqual({
      role: 'system',
      content: 'PROMPT\n\nMEMORY',
    })
  })
})

describe('tool output truncation', () => {
  it('keeps head and tail of long outputs only', () => {
    const long = `START${'x'.repeat(50_000)}END`
    const [part] = truncateToolContent([{ type: 'text', text: long }])
    const text = (part as { text: string }).text
    expect(text.length).toBeLessThan(MAX_TOOL_OUTPUT_CHARS + 100)
    expect(text.startsWith('START')).toBe(true)
    expect(text.endsWith('END')).toBe(true)
    expect(text).toContain('characters of output omitted')
    expect(truncateToolContent([{ type: 'text', text: 'short' }])).toEqual([{ type: 'text', text: 'short' }])
  })
})

describe('compaction', () => {
  it('does nothing while the tail is under the threshold', async () => {
    const w = world()
    w.chat(3)
    const { calls, summarize } = fakeSummarizer()
    const created = await compactConversation({
      bot: w.bot,
      conversationId: CONV,
      memory: w.memory,
      botsById: w.botsById,
      config: config(),
      summarize,
    })
    expect(created).toEqual([])
    expect(calls).toEqual([])
  })

  it('summarizes the oldest block down to the keep size and marks it compacted', async () => {
    const w = world()
    w.chat(30, 700) // ~12k tokens
    const cfg = config({ compactThresholdTokens: 6000, compactKeepTokens: 3000, compactBlockTokens: 20_000 })
    const { calls, summarize } = fakeSummarizer()
    const created = await compactConversation({
      bot: w.bot,
      conversationId: CONV,
      memory: w.memory,
      botsById: w.botsById,
      config: cfg,
      summarize,
    })
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ level: 0, fromSeq: 1, llmCallId: 'llm_1' })
    expect(calls[0]?.prompt).toContain('filler question 0')
    expect(calls[0]?.prompt).toMatch(/You \(Ana\): filler answer 0/)
    const next = (created[0]?.toSeq ?? 0) + 1
    expect(w.messages[next - 1]?.authorType).toBe('user')
    expect(w.memory.compacted.has(1)).toBe(true)
    expect(w.memory.compacted.has(next)).toBe(false)
    const rest = w.memory.messagesAfter(CONV, created[0]?.toSeq ?? 0, { limit: 1000 })
    expect(selectCompactionBlock(rest, w.bot, w.botsById, cfg)).toBeNull()

    // The next context starts after the watermark and carries the summary.
    const built = build(w)
    expect(built.tailStartSeq).toBe(next)
    expect((built.system.content[1] as { text: string }).text).toContain('summary #1 (level 0)')
  })

  it('merges the oldest summaries when the chain exceeds its budget (hierarchical)', async () => {
    const w = world()
    const long = 'word '.repeat(300)
    for (let i = 0; i < 6; i++) {
      w.memory.saveSummary({
        botId: w.bot.id,
        conversationId: CONV,
        level: 0,
        fromSeq: i * 10 + 1,
        toSeq: i * 10 + 10,
        content: `part ${i} ${long}`,
        tokenCount: estimateTokens(long),
        llmCallId: null,
        childIds: [],
      })
    }
    const { calls, summarize } = fakeSummarizer()
    const created = await compactConversation({
      bot: w.bot,
      conversationId: CONV,
      memory: w.memory,
      botsById: w.botsById,
      config: config({ summaryBudgetTokens: 1000 }),
      summarize,
    })
    // 6 parts → the 3 oldest merge into level 1; still over budget → level 1 + part 3 merge into level 2.
    expect(created.map((s) => [s.level, s.fromSeq, s.toSeq])).toEqual([
      [1, 1, 30],
      [2, 1, 40],
    ])
    expect(calls[0]?.prompt).toContain('<summary part="1">')
    expect(calls[0]?.prompt).toContain('part 2')
    const active = w.memory.activeSummaries(w.bot.id, CONV)
    expect(active.map((s) => [s.level, s.fromSeq])).toEqual([
      [2, 1],
      [0, 41],
      [0, 51],
    ])
    expect(active.reduce((sum, s) => sum + s.tokenCount, 0)).toBeLessThanOrEqual(1000)
    expect(w.memory.summaries.filter((s) => s.parentId === created[0]?.id)).toHaveLength(3)
    expect(w.memory.summaries.filter((s) => s.parentId === created[1]?.id)).toHaveLength(2)
  })
})

describe('memory tools', () => {
  it('saves, searches notes and searches history', () => {
    const w = world()
    w.add('user', 'The production server is 10.4.2.19.')
    w.add('user', 'Another conversation about the beach.', 'conversation_other')
    const ctx = { bot: w.bot, conversationId: CONV, botsById: w.botsById, memory: w.memory }
    const saved = executeMemoryTool(ctx, {
      id: '1',
      name: 'memory_save',
      arguments: { note: 'The user is called Fernanda.' },
    })
    expect(saved.isError).toBeUndefined()
    expect(w.memory.pinnedNotes(w.bot.id).map((n) => n.content)).toEqual(['The user is called Fernanda.'])
    const found = executeMemoryTool(ctx, { id: '2', name: 'memory_search', arguments: { query: 'fernanda' } })
    expect(textOf(found.content)).toContain('pinned')
    const history = executeMemoryTool(ctx, {
      id: '3',
      name: 'history_search',
      arguments: { query: 'production server IP', conversation: 'current' },
    })
    expect(textOf(history.content)).toContain('10.4.2.19')
    const none = executeMemoryTool(ctx, {
      id: '4',
      name: 'history_search',
      arguments: { query: 'beach', conversation: 'current' },
    })
    expect(textOf(none.content)).toBe('Nothing found.')
    expect(executeMemoryTool(ctx, { id: '5', name: 'memory_save', arguments: {} }).isError).toBe(true)
  })
})

describe('Claude Code memory bootstrap', () => {
  it('builds memory + summaries (+ recap before the pending input) with a digest of the stable part', () => {
    const w = world()
    w.memory.saveNote({ botId: w.bot.id, content: 'Prefers short answers.', pinned: true })
    w.add('user', 'old message')
    w.add('bot', 'old answer')
    w.add('user', 'new pending question')
    const fresh = buildMemoryBootstrap({
      bot: w.bot,
      conversationId: CONV,
      memory: w.memory,
      botsById: w.botsById,
      config: config(),
      recap: true,
    })
    expect(fresh.text).toContain('Prefers short answers.')
    expect(fresh.text).toContain('old message')
    expect(fresh.text).toContain('old answer')
    expect(fresh.text).not.toContain('new pending question')
    const resume = buildMemoryBootstrap({
      ...{ bot: w.bot, conversationId: CONV, memory: w.memory, botsById: w.botsById, config: config() },
      recap: false,
    })
    expect(resume.text).not.toContain('old message')
    expect(resume.digest).toBe(fresh.digest)
    w.memory.saveNote({ botId: w.bot.id, content: 'Another fact.', pinned: true })
    expect(
      buildMemoryBootstrap({
        bot: w.bot,
        conversationId: CONV,
        memory: w.memory,
        botsById: w.botsById,
        config: config(),
        recap: false,
      }).digest,
    ).not.toBe(fresh.digest)
  })
})

describe('Claude Code recap', () => {
  const build = (w: ReturnType<typeof world>) =>
    buildMemoryBootstrap({
      bot: w.bot,
      conversationId: CONV,
      memory: w.memory,
      botsById: w.botsById,
      config: config(),
      recap: true,
    })

  it('keeps only chat text: no tool activity, screen-control or system lines, and no empty memory header', () => {
    const w = world()
    const push = (partial: Partial<Message>) =>
      w.messages.push({
        id: newId('message'),
        conversationId: CONV,
        authorType: 'system',
        authorBotId: null,
        kind: 'system_event',
        content: '',
        payload: null,
        createdAt: Date.UTC(2026, 8, 1) + w.messages.length,
        ...partial,
      })
    push({ content: 'You took control of the screen' })
    w.add('user', 'check my emails')
    push({
      authorType: 'bot',
      authorBotId: w.bot.id,
      kind: 'activity',
      content:
        'click: (639, 771)\ntype: mail.google.com\nToolSearch: {"query":"select:mcp__milibot__computer"}',
      payload: { type: 'activity', turnId: 't', status: 'done', steps: [] },
    })
    w.add('bot', 'You have 3 new emails.')
    push({ content: 'Lead deleted Test' })
    w.add('user', 'what now?')

    const text = build(w).text
    expect(text).toContain('check my emails')
    expect(text).toContain('You have 3 new emails.')
    expect(text).not.toContain('mail.google.com')
    expect(text).not.toContain('ToolSearch')
    expect(text).not.toContain('took control')
    expect(text).not.toContain('deleted Test')
    expect(text).not.toContain('# Milibot memory')
    expect(text.startsWith('# Recent messages')).toBe(true)
  })

  it('stamps messages in local time, as the user sees them', () => {
    const w = world()
    const at = new Date(2026, 8, 27, 21, 12).getTime()
    w.messages.push({
      id: newId('message'),
      conversationId: CONV,
      authorType: 'user',
      authorBotId: null,
      kind: 'text',
      content: 'good morning',
      payload: null,
      createdAt: at,
    })
    w.add('bot', 'Good morning!')
    w.add('user', 'pending')
    expect(build(w).text).toContain('[2026-09-27 21:12] User: good morning')
  })

  it('stays within ~800 tokens, keeping the newest messages', () => {
    const w = world()
    w.chat(40, 600)
    w.add('user', 'pending')
    const result = build(w)
    expect(result.sections.recap).toBeLessThanOrEqual(800)
    expect(result.text).toContain('filler answer 39')
    expect(result.text).not.toContain('filler answer 0:')
  })
})

describe('memoryConfig', () => {
  it('reads budgets from settings and scales compaction with the tail budget', () => {
    const settings: Record<string, unknown> = {
      'memory.tail_budget_tokens': 8000,
      'memory.memory_budget_tokens': 'x',
    }
    const cfg = memoryConfig((key, fallback) => (settings[key] as never) ?? fallback)
    expect(cfg.tailBudgetTokens).toBe(8000)
    expect(cfg.compactThresholdTokens).toBe(8000)
    expect(cfg.compactKeepTokens).toBe(4000)
    expect(cfg.memoryBudgetTokens).toBe(DEFAULT_MEMORY_CONFIG.memoryBudgetTokens)
  })
})

describe('workspace memory', () => {
  it('goes between the system prompt and the bot memory, as its own cache breakpoint', () => {
    const w = world()
    w.memory.saveNote({
      botId: w.bot.id,
      content: 'The user pays in reais (R$).',
      pinned: true,
      scope: 'workspace',
    })
    w.memory.saveNote({ botId: w.bot.id, content: 'Spreadsheet at /workspace/finance.', pinned: true })
    w.add('user', 'hi')
    const built = build(w)
    const parts = built.system.content
    expect(parts).toHaveLength(3)
    expect(parts.map((p) => p.type === 'text' && p.cacheBreakpoint)).toEqual([true, true, true])
    expect(textOf([parts[1] as ContentPart])).toContain('# Workspace memory')
    expect(textOf([parts[1] as ContentPart])).toContain('R$')
    expect(textOf([parts[2] as ContentPart])).toContain('/workspace/finance')
    expect(textOf([parts[2] as ContentPart])).not.toContain('R$')
    expect(contextComposition(built, built.conversation).longTermMemory).toBeGreaterThan(
      estimateTokens(built.sections.memory),
    )
  })

  it('keeps the oldest notes within its budget and says how many were left out', () => {
    const w = world()
    for (let i = 0; i < 30; i++)
      w.memory.saveNote({
        botId: w.bot.id,
        content: `Workspace fact number ${i}: ${'detail '.repeat(20)}`,
        pinned: true,
        scope: 'workspace',
      })
    w.add('user', 'hi')
    const built = build(w, { workspaceMemoryBudgetTokens: 300 })
    expect(estimateTokens(built.sections.workspaceMemory)).toBeLessThanOrEqual(330)
    expect(built.sections.workspaceMemory).toContain('Workspace fact number 0:')
    expect(built.sections.workspaceMemory).not.toContain('Workspace fact number 29:')
    expect(built.sections.workspaceMemory).toMatch(/\(\d+ more workspace notes are not shown/)
    expect(build(w, { workspaceMemoryBudgetTokens: 0 }).system.content).toHaveLength(1)
  })

  it('is part of the Claude Code bootstrap and of its digest', () => {
    const w = world()
    const boot = () =>
      buildMemoryBootstrap({
        bot: w.bot,
        conversationId: CONV,
        memory: w.memory,
        botsById: w.botsById,
        config: config(),
        recap: false,
      })
    const empty = boot()
    w.memory.saveNote({
      botId: 'bot_x',
      content: 'Dates as DD/MM/YYYY.',
      pinned: false,
      scope: 'workspace',
    })
    const withNote = boot()
    expect(withNote.text).toContain('# Workspace memory')
    expect(withNote.text).toContain('DD/MM/YYYY')
    expect(withNote.digest).not.toBe(empty.digest)
  })

  it('memory_save saves to the workspace, refuses near-duplicates and updates with replaces', () => {
    const w = world()
    const ctx = { bot: w.bot, conversationId: CONV, botsById: w.botsById, memory: w.memory }
    const save = (args: Record<string, unknown>) =>
      executeMemoryTool(ctx, { id: 'x', name: 'memory_save', arguments: args })
    expect(save({ note: 'The user is Brazilian and uses R$.', scope: 'workspace' }).isError).toBeUndefined()
    expect(w.memory.workspaceNotes().map((n) => [n.botId, n.pinned])).toEqual([[null, true]])
    expect(w.memory.pinnedNotes(w.bot.id)).toEqual([])

    const again = save({ note: 'the user is brazilian, and uses R$' })
    expect(again.isError).toBeUndefined()
    expect(textOf(again.content)).toContain('Already in workspace memory')
    const similar = save({ note: 'The user is Brazilian and always uses R$.' })
    expect(similar.isError).toBe(true)
    expect(textOf(similar.content)).toContain('replaces')
    expect(w.memory.notes).toHaveLength(1)

    const replaced = save({
      note: 'The user is Portuguese and uses euros (€).',
      replaces: 'Brazilian and uses R$',
    })
    expect(textOf(replaced.content)).toContain('Updated the note in workspace memory')
    expect(w.memory.workspaceNotes().map((n) => n.content)).toEqual([
      'The user is Portuguese and uses euros (€).',
    ])
    expect(save({ note: 'x y z', replaces: 'nothing alike' }).isError).toBe(true)

    const found = executeMemoryTool(ctx, { id: 's', name: 'memory_search', arguments: { query: 'euros' } })
    expect(textOf(found.content)).toContain('workspace')
    expect(textOf(found.content)).toContain('euros')
  })

  it('memory_save merges a list of notes into one, all or none', () => {
    const w = world()
    const other = makeBot({ name: 'Other' })
    const ctx = { bot: w.bot, conversationId: CONV, botsById: w.botsById, memory: w.memory }
    const save = (args: Record<string, unknown>) =>
      executeMemoryTool(ctx, { id: 'x', name: 'memory_save', arguments: args })
    const a = w.memory.saveNote({
      botId: w.bot.id,
      content: 'Never comment on PRs.',
      pinned: true,
      scope: 'workspace',
    })
    const b = w.memory.saveNote({
      botId: w.bot.id,
      content: 'Do not write PR comments.',
      pinned: true,
      scope: 'workspace',
    })
    w.memory.saveNote({
      botId: w.bot.id,
      content: 'PR texts are in English.',
      pinned: true,
      scope: 'workspace',
    })
    const mine = w.memory.saveNote({ botId: w.bot.id, content: 'I review PR comments daily.', pinned: true })
    w.memory.saveNote({ botId: other.id, content: 'Private note of another bot.', pinned: true })
    const before = w.memory.notes.map((n) => ({ ...n }))

    const missing = save({ note: 'Merged.', replaces: [a.id, 'nothing alike at all'] })
    expect(missing.isError).toBe(true)
    expect(textOf(missing.content)).toContain('item 2 of "replaces"')
    const ambiguous = save({ note: 'Merged.', replaces: ['Never comment on PRs', 'PR'] })
    expect(ambiguous.isError).toBe(true)
    expect(textOf(ambiguous.content)).toContain('item 2 of "replaces" matches')
    const foreign = save({ note: 'Merged.', replaces: [a.id, 'Private note of another bot'] })
    expect(foreign.isError).toBe(true)
    const mixed = save({ note: 'Merged.', replaces: [a.id, mine.id] })
    expect(mixed.isError).toBe(true)
    expect(textOf(mixed.content)).toContain('"scope"')
    expect(save({ note: 'Merged.', replaces: Array.from({ length: 11 }, () => a.id) }).isError).toBe(true)
    const narrowed = save({ note: 'Merged.', scope: 'bot', replaces: [mine.id, a.id] })
    expect(narrowed.isError).toBe(true)
    expect(textOf(narrowed.content)).toContain('would take a note out of workspace memory')
    expect(textOf(narrowed.content)).toContain('Never comment on PRs.')
    expect(save({ note: 'Merged.', scope: 'bot', replaces: [a.id, b.id] }).isError).toBe(true)
    expect(w.memory.notes).toEqual(before)

    const merged = save({
      note: 'Never write comments on PRs.',
      replaces: [a.id, 'Do not write PR comments.', b.id],
    })
    expect(textOf(merged.content)).toContain('Merged 2 notes into one in workspace memory')
    expect(w.memory.workspaceNotes().map((n) => [n.id, n.content, n.createdAt])).toEqual([
      [a.id, 'Never write comments on PRs.', a.createdAt],
      [expect.any(String), 'PR texts are in English.', expect.any(Number)],
    ])

    const moved = save({
      note: 'PR rules: no comments, texts in English.',
      scope: 'workspace',
      replaces: [a.id, mine.id, 'PR texts are in English'],
    })
    expect(textOf(moved.content)).toContain('Merged 3 notes')
    expect(w.memory.workspaceNotes().map((n) => n.content)).toEqual([
      'PR rules: no comments, texts in English.',
    ])
    expect(w.memory.botNotes(w.bot.id)).toEqual([])
    expect(w.memory.botNotes(other.id)).toHaveLength(1)
  })

  it('memory_save never merges shared notes into a narrower scope', () => {
    const w = world()
    const project = { id: 'prj_site' }
    const ctx = {
      bot: w.bot,
      conversationId: CONV,
      botsById: w.botsById,
      memory: w.memory,
      projectId: project.id,
    }
    const save = (args: Record<string, unknown>) =>
      executeMemoryTool(ctx, { id: 'x', name: 'memory_save', arguments: args })
    const general = w.memory.saveNote({
      botId: w.bot.id,
      content: 'Dates are written DD/MM/YYYY.',
      pinned: true,
      scope: 'workspace',
    })
    const scoped = w.memory.saveNote({
      botId: w.bot.id,
      content: 'The site deploys on Fridays.',
      pinned: true,
      scope: 'workspace',
      projectId: project.id,
    })
    const mine = w.memory.saveNote({ botId: w.bot.id, content: 'I deploy the site myself.', pinned: true })
    const before = w.memory.notes.map((n) => ({ ...n }))

    const intoProject = save({ note: 'Merged.', scope: 'project', replaces: [scoped.id, general.id] })
    expect(intoProject.isError).toBe(true)
    expect(textOf(intoProject.content)).toContain("merging into the project's memory")
    const intoBot = save({ note: 'Merged.', scope: 'bot', replaces: [mine.id, scoped.id] })
    expect(intoBot.isError).toBe(true)
    expect(textOf(intoBot.content)).toContain("out of the project's memory")
    expect(w.memory.notes).toEqual(before)

    const widened = save({
      note: 'The site deploys on Fridays, by me.',
      scope: 'project',
      replaces: [scoped.id, mine.id],
    })
    expect(textOf(widened.content)).toContain("Merged 2 notes into one in the project's memory")
    expect(w.memory.projectNotes(project.id).map((n) => n.content)).toEqual([
      'The site deploys on Fridays, by me.',
    ])
    expect(w.memory.botNotes(w.bot.id)).toEqual([])
    expect(w.memory.workspaceNotes().map((n) => n.id)).toEqual([general.id])
  })

  it('memory_forget removes notes with a reason, all or none, never private notes of another bot', () => {
    const w = world()
    const other = makeBot({ name: 'Other' })
    const ctx = { bot: w.bot, conversationId: CONV, botsById: w.botsById, memory: w.memory }
    const forget = (args: Record<string, unknown>) =>
      executeMemoryTool(ctx, { id: 'f', name: 'memory_forget', arguments: args })
    const old = w.memory.saveNote({
      botId: w.bot.id,
      content: 'Exceptions valid for 0.3 only.',
      pinned: true,
      scope: 'workspace',
    })
    w.memory.saveNote({ botId: w.bot.id, content: 'Marco runs 3 QA sessions in parallel.', pinned: true })
    w.memory.saveNote({ botId: w.bot.id, content: 'The user prefers dark mode.', pinned: false })
    w.memory.saveNote({ botId: other.id, content: 'Other bot private fact.', pinned: true })

    expect(forget({ notes: old.id }).isError).toBe(true)
    expect(forget({ notes: old.id, reason: '  ' }).isError).toBe(true)
    expect(forget({ notes: 'Other bot private fact', reason: 'Wrong.' }).isError).toBe(true)
    const partial = forget({ notes: [old.id, 'nothing alike at all'], reason: '0.3 is over.' })
    expect(textOf(partial.content)).toContain('item 2 of "notes"')
    expect(w.memory.notes).toHaveLength(4)

    const byId = forget({ notes: old.id, reason: 'Version 0.3 is over.' })
    expect(byId.isError).toBeUndefined()
    expect(textOf(byId.content)).toContain('Exceptions valid for 0.3 only.')
    expect(byId.activity?.detail).toBe('"Exceptions valid for 0.3 only." — Version 0.3 is over.')
    expect(byId.activity?.result).toContain('Version 0.3 is over.')
    expect(w.memory.workspaceNotes()).toEqual([])

    const both = forget({
      notes: ['Marco runs 3 QA sessions in parallel.', 'prefers dark', 'prefers dark'],
      reason: 'The user said so.',
    })
    expect(textOf(both.content)).toContain('Removed 2 notes')
    expect(w.memory.botNotes(w.bot.id)).toEqual([])
    expect(w.memory.botNotes(other.id)).toHaveLength(1)
  })

  it('noteSimilarity ignores accents, case and punctuation', () => {
    expect(noteSimilarity('User prefers café!', 'user prefers cafe')).toBe(1)
    expect(noteSimilarity('Budget is 5000', 'Budget is 6000')).toBeLessThan(NEAR_DUPLICATE_SIMILARITY)
  })
})

describe('fitMemoryConfig', () => {
  it('keeps the budgets for unknown or large context windows', () => {
    expect(fitMemoryConfig(DEFAULT_MEMORY_CONFIG, null)).toBe(DEFAULT_MEMORY_CONFIG)
    expect(fitMemoryConfig(DEFAULT_MEMORY_CONFIG, 200_000)).toBe(DEFAULT_MEMORY_CONFIG)
  })

  it('shrinks every budget (and compaction with them) to half of a small window', () => {
    const fitted = fitMemoryConfig(DEFAULT_MEMORY_CONFIG, 8192)
    const total =
      fitted.tailBudgetTokens +
      fitted.memoryBudgetTokens +
      fitted.workspaceMemoryBudgetTokens +
      fitted.summaryBudgetTokens +
      fitted.retrievedBudgetTokens
    expect(total).toBeLessThanOrEqual(4096)
    expect(total).toBeGreaterThan(4000)
    expect(fitted.tailBudgetTokens).toBeLessThan(DEFAULT_MEMORY_CONFIG.tailBudgetTokens)
    expect(fitted.compactThresholdTokens / fitted.tailBudgetTokens).toBeCloseTo(
      DEFAULT_MEMORY_CONFIG.compactThresholdTokens / DEFAULT_MEMORY_CONFIG.tailBudgetTokens,
      1,
    )
    expect(fitted.compactBlockTokens).toBeLessThanOrEqual(4096)
    expect(fitted.retrievedTopK).toBe(DEFAULT_MEMORY_CONFIG.retrievedTopK)
  })
})
