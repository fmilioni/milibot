import { type Bot, foldText } from '@milibot/shared'

import type { ProjectDirectory, ToolResult } from '../environment'
import type { ToolCall } from '../llm/messages'
import { argsObject } from '../tools/args'
import { type memoryTools } from '../tools/families/memory'
import { projectViewArg } from '../tools/families/projects'
import { toolText } from '../tools/result'
import { localStamp } from './compaction'
import { searchTerms, snippetAround } from './search'
import type { MemoryBackend, MemoryNote, MemoryScope, StoredMessage } from './types'

/** Longer text is reference material: it belongs in the knowledge base (knowledge_write). */
export const MAX_NOTE_CHARS = 600
const SNIPPET_CHARS = 600

function limitArg(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.min(30, Math.max(1, value)) : 10
}

export interface MemoryToolContext {
  bot: Bot
  conversationId: string | null
  botsById: Map<string, Bot>
  memory: MemoryBackend
  /** Current project of the conversation. */
  projectId?: string | null
  projects?: ProjectDirectory | null
}

function author(message: StoredMessage, ctx: MemoryToolContext): string {
  if (message.authorType === 'user') return 'user'
  if (message.authorType === 'system') return 'system'
  if (message.authorBotId === ctx.bot.id) return 'you'
  return ctx.botsById.get(message.authorBotId ?? '')?.name ?? 'bot'
}

function words(text: string): string[] {
  return foldText(text).match(/[\p{L}\p{N}]+/gu) ?? []
}

/** Jaccard similarity of the notes' word sets (accents, case and punctuation ignored). */
export function noteSimilarity(a: string, b: string): number {
  const x = new Set(words(a))
  const y = new Set(words(b))
  if (x.size === 0 || y.size === 0) return 0
  let shared = 0
  for (const w of x) if (y.has(w)) shared++
  return shared / (x.size + y.size - shared)
}

/** Above this, a new note is taken as a restatement (or an update) of an existing one. */
export const NEAR_DUPLICATE_SIMILARITY = 0.8

function flat(text: string): string {
  return words(text).join(' ')
}

function quote(note: MemoryNote): string {
  const text = note.content.replace(/\s+/g, ' ')
  return `"${text.length > 160 ? `${text.slice(0, 159)}…` : text}"`
}

/** Note a `replaces` argument points at: its id, its whole text or a unique part of it. */
function findReplaced(candidates: MemoryNote[], ref: string): MemoryNote | MemoryNote[] | null {
  const byId = candidates.find((n) => n.id === ref.trim())
  if (byId) return byId
  const target = flat(ref)
  if (!target) return null
  const exact = candidates.filter((n) => flat(n.content) === target)
  if (exact.length === 1) return exact[0] as MemoryNote
  const partial = candidates.filter((n) => flat(n.content).includes(target))
  if (partial.length === 1) return partial[0] as MemoryNote
  return partial.length > 1 ? partial : null
}

type SaveScope = MemoryScope | 'project'

function saveNote(ctx: MemoryToolContext, a: Record<string, unknown>): ToolResult {
  const note = typeof a.note === 'string' ? a.note.trim() : ''
  if (!note) return toolText('"note" is required', true)
  if (note.length > MAX_NOTE_CHARS)
    return toolText(
      `Not saved: memory notes are short facts (max ${MAX_NOTE_CHARS} characters, this one has ${note.length}). ` +
        'Save one short fact per note; long reference material (procedures, specs, research, reports, how a ' +
        'system works) goes to the knowledge base with knowledge_write.',
      true,
    )
  const scope: SaveScope | null =
    a.scope === 'workspace' || a.scope === 'bot' || a.scope === 'project'
      ? a.scope
      : a.scope === undefined
        ? null
        : 'bot'
  const projectId = ctx.projectId ?? null
  if (scope === 'project' && !projectId)
    return toolText(
      'Not saved: this conversation has no current project. Set it with project_set_current, or save the ' +
        'note with scope "workspace" (every project) or "bot".',
      true,
    )
  const candidates = [
    ...ctx.memory.workspaceNotes(),
    ...(projectId ? ctx.memory.projectNotes(projectId) : []),
    ...ctx.memory.botNotes(ctx.bot.id),
  ]
  const where = (n: Pick<MemoryNote, 'scope' | 'projectId'>) =>
    n.scope === 'bot' ? 'your memory' : n.projectId ? "the project's memory" : 'workspace memory'
  const stored = (s: SaveScope): { scope: MemoryScope; projectId: string | null } =>
    s === 'project' ? { scope: 'workspace', projectId } : { scope: s, projectId: null }

  const replaces = typeof a.replaces === 'string' ? a.replaces.trim() : ''
  if (replaces) {
    const found = findReplaced(candidates, replaces)
    if (!found)
      return toolText(
        `No note matches "replaces" (${replaces.slice(0, 80)}). Quote the old note's text exactly as it appears in your memory.`,
        true,
      )
    if (Array.isArray(found))
      return toolText(
        `"replaces" matches ${found.length} notes: ${found.slice(0, 4).map(quote).join('; ')}. Quote more of the one to replace.`,
        true,
      )
    const target = scope ? stored(scope) : { scope: found.scope, projectId: found.projectId ?? null }
    const revised = ctx.memory.reviseNote(found.id, { content: note, botId: ctx.bot.id, ...target })
    return toolText(`Updated the note in ${where(revised)}.`)
  }

  const target = stored(scope ?? 'bot')
  const same = candidates.find((n) => flat(n.content) === flat(note))
  if (same) return toolText(`Already in ${where(same)}; nothing to save.`)
  const similar = candidates
    .map((n) => ({ n, score: noteSimilarity(n.content, note) }))
    .filter((x) => x.score >= NEAR_DUPLICATE_SIMILARITY)
    .sort((x, y) => y.score - x.score)[0]
  if (similar)
    return toolText(
      `Not saved: a very similar note already exists in ${where(similar.n)}: ${quote(similar.n)}. If yours ` +
        'corrects or completes it, call memory_save again with "replaces" set to that note; if it is already ' +
        'covered, there is nothing to do.',
      true,
    )
  const pinned = target.scope === 'workspace' || a.pinned !== false
  const saved = ctx.memory.saveNote({ botId: ctx.bot.id, content: note, pinned, ...target })
  if (target.projectId)
    return toolText(
      `Saved to the project's memory (${saved.id}); every bot sees it while working on this project.`,
    )
  if (target.scope === 'workspace')
    return toolText(`Saved to the workspace memory (${saved.id}); every bot sees it.`)
  return toolText(
    `Saved to long-term memory (${saved.id}). ${pinned ? 'Pinned: it stays in your context.' : 'Not pinned: find it with memory_search.'}`,
  )
}

function noteLabel(n: MemoryNote): string {
  const scope = n.scope === 'workspace' ? (n.projectId ? 'project' : 'workspace') : n.pinned ? 'pinned' : null
  return [localStamp(n.createdAt), scope].filter(Boolean).join(', ')
}

/** Runs `memory_save`, `memory_search` and `history_search` against the memory backend. */
export function executeMemoryTool(ctx: MemoryToolContext, call: ToolCall): ToolResult {
  const a = argsObject(call.arguments)
  switch (call.name as (typeof memoryTools.names)[number]) {
    case 'memory_save':
      return saveNote(ctx, a)
    case 'memory_search': {
      const terms = searchTerms(typeof a.query === 'string' ? a.query : '')
      if (terms.length === 0) return toolText('The query has no searchable words.', true)
      const view = projectViewArg(a.project, ctx.projectId ?? null, ctx.projects)
      if ('problem' in view) return toolText(view.problem, true)
      const notes = ctx.memory.searchNotes(ctx.bot.id, terms, limitArg(a.limit), view)
      if (notes.length === 0) return toolText('No memory notes match.')
      return toolText(notes.map((n) => `- (${noteLabel(n)}) ${n.content}`).join('\n'))
    }
    case 'history_search': {
      const terms = searchTerms(typeof a.query === 'string' ? a.query : '')
      if (terms.length === 0) return toolText('The query has no searchable words.', true)
      const limit = limitArg(a.limit)
      const scope = typeof a.conversation === 'string' ? a.conversation : 'all'
      const conversationId =
        scope === 'current' ? ctx.conversationId : scope === 'all' || !scope ? null : scope
      const messages = ctx.memory.searchMessages(terms, { botId: ctx.bot.id, conversationId, limit })
      const notes = ctx.memory.searchNotes(ctx.bot.id, terms, Math.min(5, limit), {
        mode: 'default',
        current: ctx.projectId ?? null,
      })
      const lines = messages.map((m) => {
        const where = m.conversationId === ctx.conversationId ? '' : ` [conversation ${m.conversationId}]`
        return `- (${localStamp(m.createdAt)}, ${author(m, ctx)}${where}) ${snippetAround(m.content, terms, SNIPPET_CHARS)}`
      })
      for (const n of notes)
        lines.push(
          `- (${n.scope === 'workspace' ? (n.projectId ? 'project note' : 'workspace note') : 'memory note'}, ${localStamp(n.createdAt)}) ${n.content}`,
        )
      return toolText(lines.length ? lines.join('\n') : 'Nothing found.')
    }
  }
}
