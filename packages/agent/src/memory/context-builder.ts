import type { ContextComposition } from '@milibot/shared'
import { type Bot, estimateTokens } from '@milibot/shared'

import type { ChatMessage, ContentPart } from '../llm/messages'
import type { ToolDefinition } from '../llm/provider'
import { messageToChat } from './chat-messages'
import { searchTerms, snippetAround } from './search'
import { imagesTokens, messagesTokens, messageTokens } from './tokens'
import type {
  ConversationMemorySummary,
  MemoryBackend,
  MemoryConfig,
  MemoryNote,
  StoredMessage,
} from './types'

/** How many recent messages are loaded before trimming the tail to its token budget. */
const TAIL_FETCH_LIMIT = 400
const SNIPPET_CHARS = 480

export const RETRIEVED_HEADER =
  '[Milibot memory] Older messages and notes that may be relevant to the message below (found by search; they may be outdated):'

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Long-term memory block: newest pinned notes that fit the budget, shown oldest first. */
export function formatMemoryBlock(
  notes: MemoryNote[],
  budget: number,
): { text: string; included: MemoryNote[] } {
  if (notes.length === 0 || budget <= 0) return { text: '', included: [] }
  const header =
    '# Long-term memory\nNotes you saved with memory_save. Rely on them unless the user corrects them.'
  let used = estimateTokens(header)
  const included: MemoryNote[] = []
  for (let i = notes.length - 1; i >= 0; i--) {
    const note = notes[i] as MemoryNote
    const cost = estimateTokens(note.content) + 6
    if (used + cost > budget) break
    used += cost
    included.unshift(note)
  }
  if (included.length === 0) return { text: '', included }
  const omitted = notes.length - included.length
  const lines = included.map((n) => `- (${day(n.createdAt)}) ${n.content.replace(/\s*\n\s*/g, ' ')}`)
  if (omitted > 0) lines.push(`(${omitted} older pinned notes are not shown; find them with memory_search.)`)
  return { text: `${header}\n${lines.join('\n')}`, included }
}

/**
 * Workspace memory block, shared by every bot: who the user is, their language and formats, team
 * facts. Oldest notes first; when over budget the newest ones are dropped (the seeded conventions
 * come first and must stay).
 */
export function formatWorkspaceMemoryBlock(
  notes: MemoryNote[],
  budget: number,
): { text: string; included: MemoryNote[] } {
  if (notes.length === 0 || budget <= 0) return { text: '', included: [] }
  const header =
    '# Workspace memory\nShared by every bot of this workspace (saved with memory_save scope "workspace" or by the user). Follow it unless the user says otherwise.'
  let used = estimateTokens(header)
  const included: MemoryNote[] = []
  for (const note of notes) {
    const cost = estimateTokens(note.content) + 4
    if (used + cost > budget) break
    used += cost
    included.push(note)
  }
  if (included.length === 0) return { text: '', included }
  const omitted = notes.length - included.length
  const lines = included.map((n) => `- ${n.content.replace(/\s*\n\s*/g, ' ')}`)
  if (omitted > 0)
    lines.push(`(${omitted} more workspace notes are not shown; find them with memory_search.)`)
  return { text: `${header}\n${lines.join('\n')}`, included }
}

/** Summary chain block (oldest first); keeps the newest summaries when over budget. */
export function formatSummariesBlock(summaries: ConversationMemorySummary[], budget: number): string {
  if (summaries.length === 0 || budget <= 0) return ''
  const header =
    '# Earlier in this conversation\nSummaries of older messages, oldest first. The full messages can be searched with history_search.'
  let used = estimateTokens(header)
  const included: ConversationMemorySummary[] = []
  for (let i = summaries.length - 1; i >= 0; i--) {
    const summary = summaries[i] as ConversationMemorySummary
    const cost = estimateTokens(summary.content) + 8
    if (used + cost > budget && included.length > 0) break
    used += cost
    included.unshift(summary)
  }
  const omitted = summaries.length - included.length
  const parts = included.map((s, i) => `## Part ${i + 1 + omitted}\n${s.content.trim()}`)
  if (omitted > 0) parts.unshift(`(${omitted} older summaries are not shown.)`)
  return `${header}\n\n${parts.join('\n\n')}`
}

export function summaryWatermark(summaries: ConversationMemorySummary[]): number {
  return summaries.reduce((max, s) => Math.max(max, s.toSeq), 0)
}

interface TailEntry {
  seq: number
  chat: ChatMessage
}

/** Recent unsummarized messages of the conversation that fit `budget`, starting with a user message. */
function buildTail(
  messages: StoredMessage[],
  bot: Bot,
  botsById: Map<string, Bot>,
  budget: number,
): TailEntry[] {
  const all: TailEntry[] = []
  for (const message of messages) {
    const chat = messageToChat(message, bot, botsById)
    if (chat) all.push({ seq: message.seq, chat })
  }
  let total = 0
  let start = all.length
  while (start > 0) {
    const cost = messageTokens((all[start - 1] as TailEntry).chat)
    if (total + cost > budget && start < all.length) break
    total += cost
    start--
  }
  const tail = all.slice(start)
  while (tail[0] && tail[0].chat.role !== 'user') tail.shift()
  return tail
}

/** Text that the next reply answers: what arrived after the bot's last own message. */
function latestInput(tail: TailEntry[]): string {
  const texts: string[] = []
  for (let i = tail.length - 1; i >= 0; i--) {
    const entry = tail[i] as TailEntry
    if (entry.chat.role === 'assistant') break
    texts.unshift(entry.chat.content.map((p) => (p.type === 'text' ? p.text : '')).join(' '))
  }
  return texts.join('\n')
}

interface RetrievedItem {
  kind: 'message' | 'note'
  id: string
  line: string
}

function authorLabel(message: StoredMessage, bot: Bot, botsById: Map<string, Bot>): string {
  if (message.authorType === 'user') return 'user'
  if (message.authorBotId === bot.id) return 'you'
  return botsById.get(message.authorBotId ?? '')?.name ?? 'bot'
}

/** Top-k older messages/notes matching the latest input, excluding what the context already has. */
function retrieve(input: {
  memory: MemoryBackend
  bot: Bot
  botsById: Map<string, Bot>
  conversationId: string
  query: string
  tailStartSeq: number
  excludeNoteIds: Set<string>
  topK: number
  budget: number
  /** Current project: notes of other projects are not retrieved. */
  projectId?: string | null
}): { text: string; items: RetrievedItem[] } {
  const terms = searchTerms(input.query)
  if (terms.length === 0 || input.budget <= 0 || input.topK <= 0) return { text: '', items: [] }
  const candidates: Array<RetrievedItem & { rank: number }> = []
  const seen = new Set<string>()
  const messages = input.memory.searchMessages(terms, {
    botId: input.bot.id,
    excludeFrom: { conversationId: input.conversationId, seq: input.tailStartSeq },
    limit: input.topK * 3,
  })
  messages.forEach((m, rank) => {
    if (m.kind !== 'text' || !m.content.trim()) return
    const snippet = snippetAround(m.content, terms, SNIPPET_CHARS)
    const key = snippet.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    const where = m.conversationId === input.conversationId ? '' : ', another chat'
    candidates.push({
      kind: 'message',
      id: m.id,
      rank,
      line: `- (${day(m.createdAt)}, ${authorLabel(m, input.bot, input.botsById)}${where}) ${snippet}`,
    })
  })
  const notes = input.memory.searchNotes(input.bot.id, terms, input.topK, {
    mode: 'default',
    current: input.projectId ?? null,
  })
  notes.forEach((n, rank) => {
    if (input.excludeNoteIds.has(n.id)) return
    const snippet = snippetAround(n.content, terms, SNIPPET_CHARS)
    if (seen.has(snippet.toLowerCase())) return
    seen.add(snippet.toLowerCase())
    // Notes interleave with messages: a note is worth about two message hits.
    candidates.push({
      kind: 'note',
      id: n.id,
      rank: rank * 2,
      line: `- (note, ${day(n.createdAt)}) ${snippet}`,
    })
  })
  candidates.sort((a, b) => a.rank - b.rank)
  let used = estimateTokens(RETRIEVED_HEADER)
  const items: RetrievedItem[] = []
  for (const c of candidates) {
    if (items.length >= input.topK) break
    const cost = estimateTokens(c.line)
    if (used + cost > input.budget) continue
    used += cost
    items.push({ kind: c.kind, id: c.id, line: c.line })
  }
  if (items.length === 0) return { text: '', items }
  return { text: `${RETRIEVED_HEADER}\n${items.map((i) => i.line).join('\n')}`, items }
}

export interface BuiltContext {
  /** System message: stable prompt, then (separate part) long-term memory + summaries. */
  system: ChatMessage
  /** Tail with the retrieved block placed before the latest input. Mutable: the loop appends to it. */
  conversation: ChatMessage[]
  sections: {
    systemPrompt: string
    workspaceMemory: string
    memory: string
    summaries: string
    retrieved: string
    /** Current project's block (description, notes, documents), next to the workspace memory. */
    project: string
    /** Knowledge catalog (fixed, next to the workspace memory) and the turn's relevant documents. */
    knowledgeCatalog: string
    knowledgeTurn: string
    tools: number
  }
  tailStartSeq: number
  retrieved: RetrievedItem[]
  /** Text of the latest input (what arrived after the bot's last reply). */
  input: string
}

export interface BuildContextInput {
  bot: Bot
  conversationId: string
  systemPrompt: string
  tools: ToolDefinition[]
  memory: MemoryBackend
  botsById: Map<string, Bot>
  config: MemoryConfig
  /** Knowledge base catalog; goes with the workspace memory (same cache breakpoint). */
  knowledgeCatalog?: string
  /** Current project of the conversation and its block (with the workspace memory, same breakpoint). */
  projectId?: string | null
  projectBlock?: string
}

/**
 * Context of a native (API) turn, ordered from most to least stable so providers can cache it:
 * system prompt (+ tool docs) | workspace memory | long-term memory + summary chain | recent tail, with the retrieved
 * snippets inserted right before the latest input (they change every turn).
 */
export function buildContext(input: BuildContextInput): BuiltContext {
  const { bot, memory, config } = input
  const summaries = memory.activeSummaries(bot.id, input.conversationId)
  const watermark = summaryWatermark(summaries)
  const recent = memory.messagesAfter(input.conversationId, watermark, {
    limit: TAIL_FETCH_LIMIT,
    newest: true,
  })
  const tail = buildTail(recent, bot, input.botsById, config.tailBudgetTokens)
  const lastSeq = recent.at(-1)?.seq ?? watermark
  const tailStartSeq = tail[0]?.seq ?? lastSeq + 1

  const workspaceBlock = formatWorkspaceMemoryBlock(
    memory.workspaceNotes(),
    config.workspaceMemoryBudgetTokens,
  )
  const memoryBlock = formatMemoryBlock(memory.pinnedNotes(bot.id), config.memoryBudgetTokens)
  const summariesText = formatSummariesBlock(summaries, config.summaryBudgetTokens)
  const query = latestInput(tail)
  const retrieved = retrieve({
    memory,
    bot,
    botsById: input.botsById,
    conversationId: input.conversationId,
    query,
    tailStartSeq,
    excludeNoteIds: new Set(
      [
        ...workspaceBlock.included,
        ...memoryBlock.included,
        ...(input.projectId && input.projectBlock ? memory.projectNotes(input.projectId) : []),
      ].map((n) => n.id),
    ),
    topK: config.retrievedTopK,
    budget: config.retrievedBudgetTokens,
    projectId: input.projectId ?? null,
  })

  const knowledgeCatalog = input.knowledgeCatalog?.trim() ?? ''
  const project = input.projectBlock?.trim() ?? ''
  const systemParts: ContentPart[] = [{ type: 'text', text: input.systemPrompt, cacheBreakpoint: true }]
  const shared = [workspaceBlock.text, knowledgeCatalog, project].filter(Boolean).join('\n\n')
  if (shared) systemParts.push({ type: 'text', text: shared, cacheBreakpoint: true })
  const memoryAndSummaries = [memoryBlock.text, summariesText].filter(Boolean).join('\n\n')
  if (memoryAndSummaries) systemParts.push({ type: 'text', text: memoryAndSummaries, cacheBreakpoint: true })

  const conversation = tail.map((e) => ({ ...e.chat, content: [...e.chat.content] }) as ChatMessage)
  if (retrieved.text) {
    let at = conversation.length
    while (at > 0 && conversation[at - 1]?.role !== 'assistant') at--
    const target = conversation[at]
    if (target && target.role === 'user') target.content.unshift({ type: 'text', text: retrieved.text })
    else conversation.push({ role: 'user', content: [{ type: 'text', text: retrieved.text }] })
  }
  return {
    system: { role: 'system', content: systemParts },
    conversation,
    sections: {
      systemPrompt: input.systemPrompt,
      workspaceMemory: workspaceBlock.text,
      memory: memoryBlock.text,
      summaries: summariesText,
      retrieved: retrieved.text,
      project,
      knowledgeCatalog,
      knowledgeTurn: '',
      tools: estimateTokens(JSON.stringify(input.tools)),
    },
    tailStartSeq,
    retrieved: retrieved.items,
    input: query,
  }
}

/** Puts the turn's knowledge block in the latest input, after the retrieved memory. */
export function addTurnKnowledge(built: BuiltContext, text: string): void {
  if (!text) return
  const conversation = built.conversation
  let at = conversation.length
  while (at > 0 && conversation[at - 1]?.role !== 'assistant') at--
  const target = conversation[at]
  const part: ContentPart = { type: 'text', text }
  if (target && target.role === 'user') target.content.splice(built.sections.retrieved ? 1 : 0, 0, part)
  else conversation.push({ role: 'user', content: [part] })
  built.sections.knowledgeTurn = text
}

/** Estimated tokens per section for the current state of the (growing) conversation. */
export function contextComposition(built: BuiltContext, conversation: ChatMessage[]): ContextComposition {
  const retrieved = built.sections.retrieved ? estimateTokens(built.sections.retrieved) : 0
  const knowledgeTurn = built.sections.knowledgeTurn ? estimateTokens(built.sections.knowledgeTurn) : 0
  const knowledge =
    (built.sections.knowledgeCatalog ? estimateTokens(built.sections.knowledgeCatalog) : 0) + knowledgeTurn
  const images = imagesTokens(conversation)
  return {
    systemPrompt: estimateTokens(built.sections.systemPrompt),
    longTermMemory:
      (built.sections.memory ? estimateTokens(built.sections.memory) : 0) +
      (built.sections.workspaceMemory ? estimateTokens(built.sections.workspaceMemory) : 0) +
      (built.sections.project ? estimateTokens(built.sections.project) : 0),
    summaries: built.sections.summaries ? estimateTokens(built.sections.summaries) : 0,
    retrieved,
    recentTail: Math.max(0, messagesTokens(conversation) - retrieved - knowledgeTurn - images.tokens),
    tools: built.sections.tools,
    ...(knowledge ? { knowledge } : {}),
    ...(images.count ? { images: images.tokens, imageCount: images.count } : {}),
  }
}
