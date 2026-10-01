import type { ToolExecContext, ToolResult } from '@milibot/agent'
import {
  exactInteger,
  flagArg,
  projectViewArg,
  rawTextArg,
  type ToolArgs,
  toolError,
  toolText,
  trimmedString,
} from '@milibot/agent/tools'
import { type Bot, KnowledgeKind } from '@milibot/shared'

import { formatBytesEn } from '../../util/format'
import type { ProjectService } from '../projects'
import { toolErrorResult, type ToolHandlers, ToolSwitch } from '../tools-core'
import { contentPages } from './chunker'
import { DocFailure } from './pipeline'
import { formatHits } from './search'
import { type KnowledgeService, MAX_NOTE_DOC_CHARS, modelPageMarkers, splitParts } from './service'
import type { DocRow } from './store'

/** ~8k tokens per `knowledge_read` call. */
const READ_PART_CHARS = 28_000
const SUMMARY_LINE_CHARS = 220

function kindLine(row: DocRow): string {
  const unit = row.kind === 'csv' ? 'rows' : 'p.'
  return row.pages ? `${row.kind}, ${row.pages} ${unit}` : row.kind
}

function quoted(title: string): string {
  const clipped = title.length > 60 ? `${title.slice(0, 59)}…` : title
  return `“${clipped}”`
}

function parsePages(value: string): { from: number; to: number } | null {
  const match = /^\s*(\d+)\s*(?:[-–]\s*(\d+)?\s*)?$/.exec(value)
  if (!match) return null
  const from = Number(match[1])
  const to = match[2] ? Number(match[2]) : /[-–]/.test(value) ? Number.MAX_SAFE_INTEGER : from
  return from >= 1 && to >= from ? { from, to } : null
}

const RUNNING = new AbortController().signal

export interface KnowledgeToolDeps {
  service: KnowledgeService
  botName: (id: string | null) => string | null
  projects?: ProjectService | null
}

/** The `knowledge_*` tools of a bot, over the workspace's knowledge base. */
export class KnowledgeTools extends ToolSwitch {
  readonly name = 'knowledge'
  private readonly service: KnowledgeService
  private readonly botName: (id: string | null) => string | null
  private readonly projects: ProjectService | null

  protected readonly handlers: ToolHandlers = {
    knowledge_search: (ctx, a) => this.search(ctx, a),
    knowledge_read: (ctx, a) => this.read(ctx.bot, a),
    knowledge_list: (ctx, a) => this.list(ctx, a),
    knowledge_add: (ctx, a) => this.add(ctx, a),
    knowledge_write: (ctx, a) => this.write(ctx, a),
    knowledge_edit: (ctx, a) => this.edit(ctx.bot, a),
    knowledge_delete: (ctx, a) => this.remove(ctx.bot, a),
  }

  constructor(deps: KnowledgeToolDeps) {
    super()
    this.service = deps.service
    this.botName = deps.botName
    this.projects = deps.projects ?? null
  }

  /**
   * Document problems keep their message; other errors with a code (file system, SQLite) only show the code,
   * since their message can hold host paths. The common tool errors keep their mapping.
   */
  protected override mapError(err: unknown): ToolResult | undefined {
    if (err instanceof DocFailure) return toolError(err.message)
    try {
      return toolErrorResult(err, RUNNING)
    } catch {
      const code = (err as { code?: unknown } | null)?.code
      return typeof code === 'string'
        ? toolError(`The knowledge base could not do this (${code}).`)
        : undefined
    }
  }

  private view(ctx: ToolExecContext, a: ToolArgs) {
    return projectViewArg(a.project, this.projects?.current(ctx.conversationId)?.id ?? null, this.projects)
  }

  /** Project of a new document: the `project` argument, else the conversation's current project. */
  private targetProject(ctx: ToolExecContext, a: ToolArgs): string | null | ToolResult {
    const ref = trimmedString(a.project)
    // Portuguese on purpose: models writing for a Portuguese-speaking user pass "atual".
    if (!ref || /^(current|atual)$/i.test(ref)) return this.projects?.current(ctx.conversationId)?.id ?? null
    if (!this.projects) return null
    const found = this.projects.resolve(ref)
    if ('problem' in found) return toolText(found.problem, true)
    return 'general' in found ? null : found.project.id
  }

  private resolve(bot: Bot, a: ToolArgs): DocRow | ToolResult {
    const found = this.service.resolveDoc(bot, rawTextArg(a, 'doc'))
    return 'problem' in found ? toolText(found.problem, true) : found
  }

  private async search(ctx: ToolExecContext, a: ToolArgs): Promise<ToolResult> {
    const bot = ctx.bot
    const query = trimmedString(a.query)
    if (!query) return toolText('"query" is required.', true)
    const view = this.view(ctx, a)
    if ('problem' in view) return toolText(view.problem, true)
    const topK = Math.min(20, Math.max(1, exactInteger(a, 'top_k') ?? 6))
    let docIds: string[] | null = null
    if (trimmedString(a.doc)) {
      const doc = this.resolve(bot, a)
      if ('content' in doc) return doc
      docIds = [doc.id]
    }
    const outcome = await this.service.searchForBot(bot, query, topK, docIds, docIds ? undefined : view)
    const activity = { detail: query.length > 60 ? `${query.slice(0, 59)}…` : query, fullDetail: query }
    if (!outcome.hits.length) {
      const total = this.service.docs.countVisible(bot.id, view)
      const elsewhere = view.mode === 'any' ? 0 : this.service.docs.countVisible(bot.id) - total
      return toolText(
        total
          ? `Nothing relevant found in the knowledge base. Try other words, or knowledge_list to browse.${elsewhere ? ' (Other projects were not searched: pass project "all" to include them.)' : ''}`
          : elsewhere
            ? 'No documents in scope (general and current project). Other projects have documents: pass project "all" or a project name.'
            : 'The knowledge base has no documents yet.',
        false,
        activity,
      )
    }
    const note =
      outcome.mode === 'text' ? '\n\n(Keyword search only: the semantic index is not available now.)' : ''
    return toolText(`${formatHits(outcome.hits)}${note}`, false, activity)
  }

  private read(bot: Bot, a: ToolArgs): ToolResult {
    const doc = this.resolve(bot, a)
    if ('content' in doc) return doc
    const content = this.service.readContent(doc.id)
    if (content === null || doc.chunk_count === 0) {
      if (doc.status === 'failed')
        return toolText(`${doc.title} could not be read: ${doc.error ?? doc.error_code}`, true)
      return toolText(`${doc.title} is still being processed (${doc.status}); try again in a moment.`, true)
    }
    let selection = content
    let where = ''
    const pagesArg = trimmedString(a.pages)
    const fromChunk = exactInteger(a, 'from_chunk')
    if (pagesArg) {
      const range = parsePages(pagesArg)
      if (!range) return toolText('"pages" must be a page or a range, e.g. "3" or "3-5".', true)
      const pages = contentPages(content).filter((p) => p.n !== null && p.n >= range.from && p.n <= range.to)
      if (!pages.length) {
        const last = contentPages(content).at(-1)?.n
        return toolText(
          `${doc.title} has no page ${pagesArg}${last ? ` (pages 1–${last})` : ' (it is not paginated)'}.`,
          true,
        )
      }
      selection = pages
        .map((p) => `<!-- page ${p.n} -->\n${content.slice(p.start, p.end).trim()}`)
        .join('\n\n')
      const first = pages[0]?.n
      const last = pages.at(-1)?.n
      where = first === last ? `p. ${first}` : `pp. ${first}–${last}`
    } else if (fromChunk !== null) {
      const toChunk = Math.max(fromChunk, exactInteger(a, 'to_chunk') ?? fromChunk)
      const rows = this.service.docs.chunkRange(doc.id, fromChunk, toChunk)
      if (!rows.length)
        return toolText(`${doc.title} has ${doc.chunk_count} chunks; ${fromChunk} is out of range.`, true)
      const first = rows[0] as (typeof rows)[number]
      const last = rows.at(-1) as (typeof rows)[number]
      selection = content.slice(first.char_start, last.char_end)
      if (doc.kind === 'csv' && !selection.startsWith(first.text.split('\n')[0] ?? ''))
        selection = `${first.text.split('\n')[0]}\n${selection}`
      where =
        first.page_from !== null
          ? first.page_from === last.page_to
            ? `p. ${first.page_from}`
            : `pp. ${first.page_from}–${last.page_to}`
          : ''
    }
    const parts = splitParts(selection.trim(), READ_PART_CHARS)
    const part = Math.min(Math.max(1, exactInteger(a, 'part') ?? 1), parts.length)
    const header = [
      `# ${doc.title} (${kindLine(doc)}, ${doc.id})${where ? ` · ${where}` : ''}`,
      parts.length > 1
        ? `Part ${part} of ${parts.length}${part < parts.length ? `; call again with part: ${part + 1} for more.` : '.'}`
        : null,
    ]
      .filter(Boolean)
      .join('\n')
    this.service.docs.markUsed([doc.id])
    const detail = `${quoted(doc.title)}${where ? ` ${where}` : ''}`
    return toolText(`${header}\n\n${modelPageMarkers(parts[part - 1] ?? '')}`, false, { detail })
  }

  private async list(ctx: ToolExecContext, a: ToolArgs): Promise<ToolResult> {
    const bot = ctx.bot
    const view = this.view(ctx, a)
    if ('problem' in view) return toolText(view.problem, true)
    const kind = KnowledgeKind.safeParse(trimmedString(a.kind).toLowerCase())
    let author: string | undefined
    const authorArg = trimmedString(a.author)
    if (authorArg) {
      // Portuguese on purpose: models writing for a Portuguese-speaking user pass "usuário".
      if (/^(user|usuario|usuário)$/i.test(authorArg)) author = 'user'
      else if (/^bots?$/i.test(authorArg)) author = 'bot'
      else {
        const match = this.service.botIdByRef(authorArg)
        if (!match) return toolText(`No bot named "${authorArg}".`, true)
        author = match
      }
    }
    const page = Math.max(1, exactInteger(a, 'page') ?? 1)
    const query = trimmedString(a.query)
    const result = await this.service.listForBot(bot, {
      ...(query ? { query } : {}),
      ...(kind.success ? { kind: kind.data } : {}),
      ...(author ? { author } : {}),
      page,
      project: view,
    })
    const activity = query ? { detail: query } : { detail: '' }
    if (!result.total)
      return toolText(
        query ? 'No document matches.' : 'The knowledge base has no documents yet.',
        false,
        activity,
      )
    const lines = result.rows.map((row) => {
      const by = row.author_type === 'user' ? 'user' : (this.botName(row.author_bot_id) ?? 'a bot')
      const status = row.status === 'ready' ? '' : `, ${row.status}`
      const summary = row.summary
        ? ` — ${row.summary.length > SUMMARY_LINE_CHARS ? `${row.summary.slice(0, SUMMARY_LINE_CHARS - 1)}…` : row.summary}`
        : ''
      const pin = row.pinned ? ' [pinned]' : ''
      const project = row.project_id
        ? `, project ${this.projects?.find(row.project_id)?.name ?? row.project_id}`
        : ''
      return `- ${row.title}${pin} (${kindLine(row)}, ${formatBytesEn(row.bytes)}, by ${by}${project}${status}, ${row.id})${summary}`
    })
    const more = result.page < result.pageCount ? ` Next: page ${result.page + 1}.` : ''
    return toolText(
      `Page ${result.page} of ${result.pageCount} (${result.total} document${result.total === 1 ? '' : 's'}).${more}\n${lines.join('\n')}`,
      false,
      activity,
    )
  }

  private async add(ctx: ToolExecContext, a: ToolArgs): Promise<ToolResult> {
    const path = trimmedString(a.path)
    if (!path) return toolText('"path" is required.', true)
    const projectId = this.targetProject(ctx, a)
    if (projectId !== null && typeof projectId !== 'string') return projectId
    const { doc, updated } = await this.service.addFromVm(ctx.bot, {
      path,
      title: trimmedString(a.title) || null,
      scope: this.service.scopeFor(ctx.bot, a.scope),
      ...(trimmedString(a.project) ? { projectId } : { newDocProjectId: projectId }),
      conversationId: ctx.conversationId,
    })
    const status =
      doc.status === 'queued' && this.service.waitsForVm(doc.id)
        ? 'It will be indexed when the VM is running.'
        : 'It is being indexed and will be searchable in a moment.'
    return toolText(`${updated ? 'Updated' : 'Added'} ${quoted(doc.title)} (${doc.id}). ${status}`, false, {
      detail: doc.title,
    })
  }

  private write(ctx: ToolExecContext, a: ToolArgs): ToolResult {
    const title = trimmedString(a.title).slice(0, 200)
    const content = rawTextArg(a, 'content')
    if (!title) return toolText('"title" is required.', true)
    if (!content.trim()) return toolText('"content" is required (the whole document in markdown).', true)
    if (content.length > MAX_NOTE_DOC_CHARS)
      return toolText(
        `The document is too long (${content.length} characters, max ${MAX_NOTE_DOC_CHARS}); split it.`,
        true,
      )
    let replace: DocRow | null = null
    if (trimmedString(a.doc)) {
      const doc = this.resolve(ctx.bot, a)
      if ('content' in doc) return doc
      if (doc.source !== 'bot')
        return toolText(
          `${quoted(doc.title)} was added by the user and cannot be replaced; write a new document instead.`,
          true,
        )
      replace = doc
    }
    const pinned = flagArg(a, 'pinned')
    const projectId = this.targetProject(ctx, a)
    if (projectId !== null && typeof projectId !== 'string') return projectId
    const { doc, created } = this.service.writeNote(ctx.bot, {
      title,
      content,
      replace,
      ...(pinned !== undefined ? { pinned } : {}),
      // A replaced document keeps its project unless the bot names one.
      ...(!replace || trimmedString(a.project) ? { projectId } : {}),
      conversationId: ctx.conversationId,
    })
    const pinNote =
      pinned !== undefined && replace && replace.author_bot_id !== ctx.bot.id
        ? ' (Not pinned: only the bot that wrote it can pin it.)'
        : ''
    return toolText(
      `${created ? 'Saved' : 'Replaced'} ${quoted(doc.title)} in the knowledge base (${doc.id}).${pinNote}`,
      false,
      { detail: doc.title },
    )
  }

  private edit(bot: Bot, a: ToolArgs): ToolResult {
    const doc = this.resolve(bot, a)
    if ('content' in doc) return doc
    if (doc.source !== 'bot')
      return toolText(
        `${quoted(doc.title)} was added by the user and cannot be edited; write a new document instead.`,
        true,
      )
    const oldText = rawTextArg(a, 'old_text')
    if (!oldText) return toolText('"old_text" is required (exact text to replace).', true)
    const { replaced } = this.service.editNote(
      doc,
      oldText,
      rawTextArg(a, 'new_text'),
      a.replace_all === true,
    )
    return toolText(
      `Edited ${quoted(doc.title)} (${replaced} replacement${replaced === 1 ? '' : 's'}).`,
      false,
      {
        detail: doc.title,
      },
    )
  }

  private async remove(bot: Bot, a: ToolArgs): Promise<ToolResult> {
    const doc = this.resolve(bot, a)
    if ('content' in doc) return doc
    if (doc.author_type !== 'bot' || doc.author_bot_id !== bot.id)
      return toolText(
        `${quoted(doc.title)} was ${doc.author_type === 'user' ? 'added by the user' : 'written by another bot'}; only its author can delete it (the user can, in Settings).`,
        true,
      )
    await this.service.delete(doc.id)
    return toolText(`Deleted ${quoted(doc.title)}.`, false, { detail: doc.title })
  }
}
