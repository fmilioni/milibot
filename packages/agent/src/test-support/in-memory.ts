import { estimateTokens, inProjectView, type Message, newId, type ProjectView } from '@milibot/shared'

import { termScore } from '../memory/search'
import type {
  ConversationMemorySummary,
  MemoryBackend,
  MemoryNote,
  MemoryScope,
  MessageSearchOptions,
  NewSummary,
  StoredMessage,
} from '../memory/types'

/**
 * MemoryBackend over plain arrays (tests and the long-memory eval). Messages come from the caller's
 * list (seq = position + 1); search ranks by matched terms instead of FTS5 bm25.
 */
export class InMemoryMemory implements MemoryBackend {
  notes: MemoryNote[] = []
  summaries: Array<ConversationMemorySummary> = []
  compacted = new Set<number>()

  constructor(
    private readonly messages: () => Message[],
    private readonly memberOf: (botId: string, conversationId: string) => boolean = () => true,
    private readonly now: () => number = Date.now,
  ) {}

  private stored(): StoredMessage[] {
    return this.messages().map((m, i) => ({ ...m, seq: i + 1 }))
  }

  pinnedNotes(botId: string): MemoryNote[] {
    return this.notes.filter((n) => n.pinned && n.scope === 'bot' && n.botId === botId)
  }

  workspaceNotes(): MemoryNote[] {
    return this.notes.filter((n) => n.scope === 'workspace' && !n.projectId)
  }

  projectNotes(projectId: string): MemoryNote[] {
    return this.notes.filter((n) => n.scope === 'workspace' && n.projectId === projectId)
  }

  botNotes(botId: string): MemoryNote[] {
    return this.notes.filter((n) => n.scope === 'bot' && n.botId === botId)
  }

  reviseNote(
    id: string,
    input: {
      content: string
      scope: MemoryScope
      botId: string
      projectId?: string | null
      absorbs?: string[]
    },
  ): MemoryNote {
    const note = this.notes.find((n) => n.id === id)
    if (!note) throw new Error(`memory note not found: ${id}`)
    this.forgetNotes((input.absorbs ?? []).filter((other) => other !== id))
    note.content = input.content
    note.scope = input.scope
    note.botId = input.scope === 'workspace' ? null : input.botId
    if (input.scope !== 'workspace') note.projectId = null
    else if (input.projectId !== undefined) note.projectId = input.projectId
    if (input.scope === 'workspace') note.pinned = true
    note.tokenCount = estimateTokens(input.content)
    note.updatedAt = this.now()
    return note
  }

  forgetNotes(ids: string[]): void {
    const missing = ids.find((id) => !this.notes.some((n) => n.id === id))
    if (missing) throw new Error(`memory note not found: ${missing}`)
    this.notes = this.notes.filter((n) => !ids.includes(n.id))
  }

  saveNote(input: {
    botId: string
    content: string
    pinned: boolean
    scope?: MemoryScope
    projectId?: string | null
  }): MemoryNote {
    const scope = input.scope ?? 'bot'
    const botId = scope === 'workspace' ? null : input.botId
    const projectId = scope === 'workspace' ? (input.projectId ?? null) : null
    const existing = this.notes.find(
      (n) =>
        n.scope === scope &&
        n.botId === botId &&
        (n.projectId ?? null) === projectId &&
        n.content === input.content,
    )
    const now = this.now()
    if (existing) {
      existing.pinned = existing.pinned || input.pinned
      existing.updatedAt = now
      return existing
    }
    const note: MemoryNote = {
      id: newId('memory'),
      scope,
      botId,
      projectId,
      content: input.content,
      pinned: scope === 'workspace' || input.pinned,
      tokenCount: estimateTokens(input.content),
      createdAt: now,
      updatedAt: now,
    }
    this.notes.push(note)
    return note
  }

  searchNotes(botId: string, terms: string[], limit: number, project?: ProjectView): MemoryNote[] {
    return this.notes
      .filter((n) => n.botId === botId || (n.botId === null && inProjectView(n.projectId ?? null, project)))
      .map((n) => ({ n, score: termScore(n.content, terms) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.n.createdAt - a.n.createdAt)
      .slice(0, limit)
      .map((x) => x.n)
  }

  searchMessages(terms: string[], options: MessageSearchOptions): StoredMessage[] {
    return this.stored()
      .filter((m) => m.kind === 'text' || m.kind === 'activity')
      .filter((m) => !(m.payload?.type === 'text' && m.payload.streaming))
      .filter((m) => !(m.payload?.type === 'activity' && m.payload.status === 'running'))
      .filter((m) => this.memberOf(options.botId, m.conversationId))
      .filter((m) => !options.conversationId || m.conversationId === options.conversationId)
      .filter(
        (m) =>
          !options.excludeFrom ||
          m.conversationId !== options.excludeFrom.conversationId ||
          m.seq < options.excludeFrom.seq,
      )
      .map((m) => ({ m, score: termScore(m.content, terms) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.m.seq - a.m.seq)
      .slice(0, options.limit)
      .map((x) => x.m)
  }

  activeSummaries(botId: string, conversationId: string): ConversationMemorySummary[] {
    return this.summaries
      .filter((s) => s.botId === botId && s.conversationId === conversationId && s.parentId === null)
      .sort((a, b) => a.fromSeq - b.fromSeq)
  }

  messagesAfter(
    conversationId: string,
    afterSeq: number,
    options: { limit: number; newest?: boolean },
  ): StoredMessage[] {
    const all = this.stored().filter((m) => m.conversationId === conversationId && m.seq > afterSeq)
    return options.newest ? all.slice(-options.limit) : all.slice(0, options.limit)
  }

  saveSummary(summary: NewSummary): ConversationMemorySummary {
    const record: ConversationMemorySummary = {
      id: newId('summary'),
      conversationId: summary.conversationId,
      botId: summary.botId,
      level: summary.level,
      parentId: null,
      fromSeq: summary.fromSeq,
      toSeq: summary.toSeq,
      content: summary.content,
      tokenCount: summary.tokenCount,
      llmCallId: summary.llmCallId,
      createdAt: this.now(),
    }
    for (const child of this.summaries) if (summary.childIds.includes(child.id)) child.parentId = record.id
    if (summary.level === 0) {
      for (const m of this.stored()) {
        if (m.conversationId === summary.conversationId && m.seq >= summary.fromSeq && m.seq <= summary.toSeq)
          this.compacted.add(m.seq)
      }
    }
    this.summaries.push(record)
    return record
  }
}
