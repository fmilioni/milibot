import type { ToolExecContext, ToolResult } from '@milibot/agent'
import {
  type BoardToolName,
  flagArg,
  projectViewArg,
  textArg,
  type ToolArgs,
  toolError,
  ToolInputError,
  toolText,
  trimmedString,
} from '@milibot/agent/tools'
import {
  BOARD_CARD_STATUSES,
  BOARD_LIMITS,
  BOARD_USER,
  type BoardCardLink,
  BoardCardLinkKind,
  BoardCardStatus,
  type Bot,
  columnCards,
  DueDate,
  inProjectView,
  isOverdue,
  localDate,
} from '@milibot/shared'

import type { ProjectService } from '../projects'
import { foldKey, oneLine, type ToolHandler, ToolSwitch } from '../tools-core'
import type { BoardService } from './service'
import type { BoardRow, CardRow } from './store'

const MAX_NEW_CARDS = 60

const COLUMN_NAME: Record<BoardCardStatus, string> = {
  todo: 'To do',
  doing: 'Doing',
  done: 'Done',
  dropped: 'Dropped',
}

const date = (ms: number) => new Date(ms).toISOString().slice(0, 10)

function parseDue(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return undefined
  const raw = trimmedString(value)
  if (!raw) return null
  if (!DueDate.safeParse(raw).success)
    throw new ToolInputError('"due" must be a date as YYYY-MM-DD ("" clears it)')
  return raw
}

function clipped(value: unknown, max: number, name: string): string | undefined {
  if (value === undefined || value === null) return undefined
  const text = typeof value === 'string' ? value.trim() : String(value)
  if (text.length > max) throw new ToolInputError(`"${name}" is longer than ${max} characters`)
  return text
}

/** A whole number given as a number or numeric text; undefined when absent, null for "" (clears). */
function wholeNumber(value: unknown, name: string): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null || (typeof value === 'string' && !value.trim())) return null
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isInteger(n) || n < 0) throw new ToolInputError(`"${name}" must be a whole number from 0`)
  return n
}

function nameList(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null) return undefined
  const items = typeof value === 'string' ? (value.trim() ? value.split(',') : []) : value
  if (!Array.isArray(items)) throw new ToolInputError(`"${name}" must be a list of names`)
  return [...new Set(items.map((item) => trimmedString(item)).filter(Boolean))]
}

export interface BoardToolsDeps {
  boards: BoardService
  projects: Pick<ProjectService, 'current' | 'find' | 'resolve'>
  getBot: (id: string) => Bot | null
  /** A bot by the name, slug or id a model gives. */
  resolveBot?: (ref: string) => Bot | null
  /** The bot's current chat, else its DM. */
  cardConversation: (bot: Bot, conversationId: string | null) => string
  now: () => number
}

export class BoardTools extends ToolSwitch {
  readonly name = 'boards'
  protected readonly handlers: Record<BoardToolName, ToolHandler> = {
    board_create: (ctx, a) => this.create(ctx, a),
    board_list: (ctx, a) => this.list(ctx, a),
    board_get: (_ctx, a) => this.get(a),
    board_update: (_ctx, a) => this.update(a),
    board_delete: (_ctx, a) => this.remove(a),
    board_card_write: (ctx, a) => this.writeCard(ctx, a),
    board_card_get: (_ctx, a) => this.getCard(a),
    board_comment: (ctx, a) => this.comment(ctx, a),
    board_link: (ctx, a) => this.link(ctx, a),
    board_search: (ctx, a) => this.search(ctx, a),
  }

  constructor(private readonly deps: BoardToolsDeps) {
    super()
  }

  private get boards() {
    return this.deps.boards
  }

  private get store() {
    return this.deps.boards.store
  }

  private projectFilter(ctx: ToolExecContext, a: ToolArgs): (projectId: string | null) => boolean {
    const current = this.deps.projects.current(ctx.conversationId)?.id ?? null
    const view = projectViewArg(a.project, current, this.deps.projects)
    if ('problem' in view) throw new ToolInputError(view.problem)
    return (projectId) => inProjectView(projectId, view)
  }

  private projectName(projectId: string | null): string {
    if (!projectId) return 'general'
    return this.deps.projects.find(projectId)?.name ?? 'general'
  }

  private today(): string {
    return localDate(this.deps.now())
  }

  private dueText(dueDate: string | null, status: Parameters<typeof isOverdue>[0]['status']): string {
    if (!dueDate) return ''
    return ` · due ${dueDate}${isOverdue({ dueDate, status }, this.today()) ? ' (overdue)' : ''}`
  }

  private linkText(link: BoardCardLink): string {
    const state = link.state ? ` [${link.state}]` : ''
    switch (link.kind) {
      case 'plan':
      case 'session':
      case 'design':
        return `${link.kind} "${link.label}" (${link.ref})`
      case 'pr':
        return `PR ${link.label}${state} ${link.url ?? link.ref}`
      case 'commit':
        return `commit ${link.ref.slice(0, 12)}${link.label && link.label !== link.ref.slice(0, 7) ? ` ${link.label}` : ''}`
      case 'url':
        return `link ${link.label === link.ref ? link.ref : `${link.label} ${link.ref}`}`
    }
  }

  private boardLine(row: BoardRow): string {
    const board = this.store.toBoard(row)
    const total = board.counts.todo + board.counts.doing + board.counts.done + board.counts.dropped
    return (
      `- ${row.title} [${board.status}${row.archived_at !== null ? ', archived' : ''}, ${board.counts.done}/${total - board.counts.dropped} done` +
      `${board.counts.doing ? `, ${board.counts.doing} doing` : ''}] (${row.id}) · ${this.projectName(row.project_id)}` +
      `${this.dueText(row.due_date, board.status)} · ${date(row.updated_at)}` +
      (row.summary ? ` — ${oneLine(row.summary, 200)}` : '')
    )
  }

  private problemsText(problems: string[]): string {
    return problems.length ? `\n${problems.join('\n')}` : ''
  }

  private async create(ctx: ToolExecContext, a: ToolArgs): Promise<ToolResult> {
    const title = clipped(a.title, BOARD_LIMITS.title, 'title')
    const summary = clipped(a.summary, BOARD_LIMITS.summary, 'summary')
    if (!title) throw new ToolInputError('"title" is required')
    if (!summary) throw new ToolInputError('"summary" is required (what the board covers and why)')
    let projectId: string | null
    if (textArg(a, 'project')) {
      const found = this.deps.projects.resolve(textArg(a, 'project'))
      if ('problem' in found) throw new ToolInputError(found.problem)
      projectId = 'project' in found ? found.project.id : null
    } else projectId = this.deps.projects.current(ctx.conversationId)?.id ?? null
    const rawCards = a.cards === undefined || a.cards === null ? [] : a.cards
    if (!Array.isArray(rawCards))
      throw new ToolInputError('"cards" must be a list of {title, summary?, body?, due?}')
    if (rawCards.length > MAX_NEW_CARDS) throw new ToolInputError(`at most ${MAX_NEW_CARDS} cards at once`)
    const cards = rawCards.map((raw, i) => {
      const c = (raw && typeof raw === 'object' ? raw : { title: raw }) as ToolArgs
      const cardTitle = clipped(c.title, BOARD_LIMITS.title, `cards[${i}].title`)
      if (!cardTitle) throw new ToolInputError(`cards[${i}].title is empty`)
      return {
        title: cardTitle,
        summary: clipped(c.summary, BOARD_LIMITS.summary, `cards[${i}].summary`) ?? '',
        body: clipped(c.body, BOARD_LIMITS.body, `cards[${i}].body`) ?? '',
        dueDate: parseDue(c.due) ?? null,
      }
    })
    const board = this.boards.createBoard({
      title,
      summary,
      projectId,
      dueDate: parseDue(a.due) ?? null,
      bot: ctx.bot,
      conversationId: this.deps.cardConversation(ctx.bot, ctx.conversationId),
      turnId: ctx.turnId,
    })
    const problems: string[] = []
    const created: CardRow[] = []
    for (const card of cards) {
      const imported = await this.boards.images.importMarkdown(board, card.body)
      problems.push(...imported.problems)
      created.push(
        this.boards.addCard(board.id, {
          ...card,
          body: imported.text,
          status: 'todo',
          createdByBotId: ctx.bot.id,
        }),
      )
    }
    this.boards.changed(board.id, { cards: true, reindex: [board.id, ...created.map((c) => c.id)] })
    return toolText(
      `Created the board "${title}" (${board.id}) with ${created.length} card${created.length === 1 ? '' : 's'}` +
        `${created.length ? `:\n${created.map((c) => `- ${c.title} (${c.id})`).join('\n')}` : '. Add cards with board_card_write.'}` +
        this.problemsText(problems),
      false,
      { detail: title },
    )
  }

  private list(ctx: ToolExecContext, a: ToolArgs): ToolResult {
    const archived = a.archived === true
    const inView = this.projectFilter(ctx, a)
    const rows = this.store.boards({ archived }).filter((r) => inView(r.project_id))
    if (!rows.length)
      return toolText(
        archived
          ? 'There are no boards here.'
          : 'There are no active boards here (archived: true includes archived ones).',
      )
    return toolText(
      rows
        .slice(0, 60)
        .map((r) => this.boardLine(r))
        .join('\n') + '\n\nOpen one with board_get.',
    )
  }

  private get(a: ToolArgs): ToolResult {
    const row = this.boards.resolveBoard(textArg(a, 'board'))
    const board = this.store.toBoard(row)
    const cards = this.store.toCards(row.id)
    const author = row.bot_id ? (this.deps.getBot(row.bot_id)?.name ?? 'a deleted bot') : 'the user'
    const total = cards.length
    const lines = [
      `Board "${row.title}" (${row.id}) · ${board.status}${row.archived_at !== null ? ' · archived' : ''} · ` +
        `${board.counts.done}/${total - board.counts.dropped} done · project ${this.projectName(row.project_id)}` +
        `${this.dueText(row.due_date, board.status)} · by ${author}`,
      ...(row.summary ? [row.summary] : []),
      ...(board.labels.length ? [`Labels: ${board.labels.map((l) => l.name).join(', ')}`] : []),
    ]
    for (const status of BOARD_CARD_STATUSES) {
      const column = columnCards(cards, status)
      const limit = status === 'doing' && row.doing_limit ? `/${row.doing_limit} limit` : ''
      lines.push('', `## ${COLUMN_NAME[status]} (${column.length}${limit})`)
      for (const card of column) {
        const extras = [
          card.assignees.length ? `assigned to ${this.assigneeNames(card.assignees)}` : '',
          card.labelIds.length ? `labels: ${this.labelNames(card.labelIds, row.id)}` : '',
          card.dueDate ? `due ${card.dueDate}${isOverdue(card, this.today()) ? ' (overdue)' : ''}` : '',
          card.commentCount ? `${card.commentCount} comment${card.commentCount === 1 ? '' : 's'}` : '',
          card.links.length ? card.links.map((l) => this.linkText(l)).join('; ') : '',
        ].filter(Boolean)
        lines.push(
          `- ${card.title} (${card.id})${card.summary ? ` — ${oneLine(card.summary, 200)}` : ''}` +
            (extras.length ? ` · ${extras.join(' · ')}` : ''),
        )
      }
    }
    lines.push('', 'Read a card (body and comments) with board_card_get before working on it.')
    return toolText(lines.join('\n'), false, { detail: row.title })
  }

  private update(a: ToolArgs): ToolResult {
    const archived = flagArg(a, 'archived')
    const other = ['title', 'summary', 'due', 'doing_limit'].some((k) => a[k] !== undefined && a[k] !== null)
    const row = this.boards.resolveBoard(textArg(a, 'board'), other && archived !== false)
    const title = clipped(a.title, BOARD_LIMITS.title, 'title')
    if (title === '') throw new ToolInputError('"title" cannot be empty')
    const summary = clipped(a.summary, BOARD_LIMITS.summary, 'summary')
    const due = parseDue(a.due)
    const position = wholeNumber(a.position, 'position')
    const rawLimit = wholeNumber(a.doing_limit, 'doing_limit')
    const doingLimit = rawLimit === 0 ? null : rawLimit
    if (doingLimit !== undefined && doingLimit !== null && doingLimit > BOARD_LIMITS.doingLimit)
      throw new ToolInputError(`"doing_limit" goes up to ${BOARD_LIMITS.doingLimit} (0 or "" removes it)`)
    this.boards.updateBoard(row.id, {
      ...(title !== undefined ? { title } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(due !== undefined ? { dueDate: due } : {}),
      ...(archived !== undefined ? { archived } : {}),
      ...(doingLimit !== undefined ? { doingLimit } : {}),
    })
    if (position !== undefined && position !== null) this.boards.reorderBoard(row.id, position)
    const what = archived === true ? 'Archived' : archived === false ? 'Unarchived' : 'Updated'
    const over = this.overLimitText(row.id)
    return toolText(`${what} the board "${title ?? row.title}" (${row.id}).${over}`, false, {
      detail: row.title,
    })
  }

  /** A warning when the board's Doing column is past its limit ('' otherwise). */
  private overLimitText(boardId: string): string {
    const over = this.boards.doingOverLimit(boardId)
    return over
      ? ` Doing now has ${over.doing} cards, over the board's limit of ${over.limit}: finish or move one before starting more.`
      : ''
  }

  private remove(a: ToolArgs): ToolResult {
    const row = this.boards.resolveBoard(textArg(a, 'board'))
    this.boards.deleteBoard(row.id)
    return toolText(`Deleted the board "${row.title}" (${row.id}) with its cards.`, false, {
      detail: row.title,
    })
  }

  private placeIndex(
    boardId: string,
    status: BoardCardStatus,
    before: unknown,
    cardId: string | null,
  ): number {
    const column = columnCards(this.store.cards(boardId), status).filter((c) => c.id !== cardId)
    const ref = typeof before === 'string' ? before.trim() : ''
    if (!ref) return column.length
    const target = this.boards.resolveCard(ref)
    const index = column.findIndex((c) => c.id === target.id)
    if (index < 0)
      throw new ToolInputError(`"before": "${target.title}" is not in the ${COLUMN_NAME[status]} column`)
    return index
  }

  /** Bot names and "user" → assignee ids. */
  private assigneeIds(value: unknown): string[] | undefined {
    const names = nameList(value, 'assignees')
    return names?.map((ref) => {
      if (foldKey(ref) === BOARD_USER) return BOARD_USER
      const bot = this.deps.resolveBot?.(ref) ?? this.deps.getBot(ref)
      if (!bot) throw new ToolInputError(`"assignees": there is no bot "${ref}" (use "user" for the user)`)
      return bot.id
    })
  }

  /** Label names → the board's label ids, adding the labels it doesn't have yet. */
  private labelIds(boardId: string, value: unknown): string[] | undefined {
    const names = nameList(value, 'labels')
    return names?.map((name) => {
      if (name.length > BOARD_LIMITS.labelName)
        throw new ToolInputError(`"labels": "${name}" is longer than ${BOARD_LIMITS.labelName} characters`)
      return (this.store.labelByName(boardId, name) ?? this.boards.addLabel(boardId, name)).id
    })
  }

  private assigneeNames(assignees: readonly string[]): string {
    return assignees
      .map((a) => (a === BOARD_USER ? 'the user' : (this.deps.getBot(a)?.name ?? 'a deleted bot')))
      .join(', ')
  }

  private labelNames(labelIds: readonly string[], boardId: string): string {
    const labels = new Map(this.store.labels(boardId).map((l) => [l.id, l.name]))
    return labelIds.flatMap((id) => labels.get(id) ?? []).join(', ')
  }

  private async writeCard(ctx: ToolExecContext, a: ToolArgs): Promise<ToolResult> {
    const status =
      a.status === undefined || a.status === null ? undefined : BoardCardStatus.safeParse(a.status)
    if (status && !status.success) throw new ToolInputError('"status" must be todo, doing, done or dropped')
    const title = clipped(a.title, BOARD_LIMITS.title, 'title')
    const summary = clipped(a.summary, BOARD_LIMITS.summary, 'summary')
    const rawBody = clipped(a.body, BOARD_LIMITS.body, 'body')
    const due = parseDue(a.due)
    const assignees = this.assigneeIds(a.assignees)

    if (!textArg(a, 'card')) {
      if (!textArg(a, 'board'))
        throw new ToolInputError('pass "card" to change a card, or "board" and "title" to add one')
      if (!title) throw new ToolInputError('"title" is required for a new card')
      const board = this.boards.resolveBoard(textArg(a, 'board'), true)
      const imported = rawBody
        ? await this.boards.images.importMarkdown(board, rawBody)
        : { text: '', problems: [] }
      const cardStatus = status?.data ?? 'todo'
      const index = a.before === undefined ? undefined : this.placeIndex(board.id, cardStatus, a.before, null)
      const labelIds = this.labelIds(board.id, a.labels)
      const card = this.boards.addCard(board.id, {
        title,
        summary: summary ?? '',
        body: imported.text,
        status: cardStatus,
        dueDate: due ?? null,
        createdByBotId: ctx.bot.id,
        ...(assignees ? { assignees } : {}),
        ...(labelIds ? { labelIds } : {}),
        ...(index !== undefined ? { index } : {}),
      })
      this.boards.changed(board.id, { cards: true, reindex: [card.id] })
      return toolText(
        `Added the card "${title}" (${card.id}) to ${COLUMN_NAME[cardStatus]} of "${board.title}".` +
          (cardStatus === 'doing' ? this.overLimitText(board.id) : '') +
          this.problemsText(imported.problems),
        false,
        { detail: title },
      )
    }

    const card = this.boards.resolveCard(textArg(a, 'card'), true)
    if (title === '') throw new ToolInputError('"title" cannot be empty')
    const from = this.boards.resolveBoard(card.board_id)
    const to = textArg(a, 'board') ? this.boards.resolveBoard(textArg(a, 'board'), true) : from
    const changesBoard = to.id !== from.id
    if (changesBoard) {
      const target = status?.data ?? card.status
      const index = a.before === undefined ? undefined : this.placeIndex(to.id, target, a.before, card.id)
      this.boards.moveCardToBoard(card.id, to.id, {
        status: target,
        ...(index !== undefined ? { index } : {}),
        author: { type: 'bot', botId: ctx.bot.id },
      })
    }
    const board = to
    const imported = rawBody !== undefined ? await this.boards.images.importMarkdown(board, rawBody) : null
    const labelIds = this.labelIds(board.id, a.labels)
    this.boards.updateCard(card.id, {
      ...(title !== undefined ? { title } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(imported ? { body: imported.text } : {}),
      ...(due !== undefined ? { dueDate: due } : {}),
      ...(assignees ? { assignees } : {}),
      ...(labelIds ? { labelIds } : {}),
    })
    const target = status?.data ?? card.status
    if (!changesBoard && (status || a.before !== undefined))
      this.boards.moveCard(card.id, target, this.placeIndex(board.id, target, a.before, card.id), ctx.bot.id)
    this.boards.changed(board.id, {
      cards: true,
      reindex: title !== undefined || summary !== undefined ? [card.id] : [],
    })
    const moved = changesBoard
      ? ` Moved from "${from.title}" to ${COLUMN_NAME[target]} of "${to.title}", with its comments, links and images.`
      : status && status.data !== card.status
        ? ` Moved to ${COLUMN_NAME[status.data]}.`
        : ''
    const finished = (row: BoardRow) =>
      this.store.toBoard(this.store.board(row.id) as BoardRow).status === 'done'
    const statusChanged = status?.data !== card.status
    const completed = [
      ...(changesBoard && finished(from) ? [from] : []),
      ...((changesBoard || statusChanged) && finished(board) ? [board] : []),
    ]
    return toolText(
      `Updated the card "${title ?? card.title}" (${card.id}).${moved}` +
        completed.map((b) => ` Every card of "${b.title}" is now done or dropped.`).join('') +
        (target === 'doing' && (changesBoard || card.status !== 'doing')
          ? this.overLimitText(board.id)
          : '') +
        this.problemsText(imported?.problems ?? []),
      false,
      { detail: title ?? card.title },
    )
  }

  private async getCard(a: ToolArgs): Promise<ToolResult> {
    const card = this.boards.resolveCard(textArg(a, 'card'))
    const board = this.boards.resolveBoard(card.board_id)
    const comments = this.store.comments(card.id)
    await this.boards.images.ensure(board.id, [card.body, ...comments.map((c) => c.body)])
    const links = this.store.links(card.id)
    const assignees = this.store.assignees(card.id)
    const labels = this.labelNames(this.store.cardLabelIds(card.id), board.id)
    const lines = [
      `Card "${card.title}" (${card.id}) · ${COLUMN_NAME[card.status]} · board "${board.title}" (${board.id})` +
        `${assignees.length ? ` · assigned to ${this.assigneeNames(assignees)}` : ''}` +
        `${labels ? ` · labels: ${labels}` : ''}${this.dueText(card.due_date, card.status)}`,
      ...(card.summary ? [`Summary: ${card.summary}`] : []),
      '',
      card.body.trim() ? this.boards.forBot(board.id, card.body) : '(no body)',
      '',
      links.length ? `Links:\n${links.map((l) => `- ${this.linkText(l)}`).join('\n')}` : 'Links: none',
      '',
      comments.length
        ? `Comments (${comments.length}):\n${comments
            .map(
              (c) =>
                `- (${new Date(c.createdAt).toISOString().slice(0, 16).replace('T', ' ')}, ` +
                `${this.boards.authorName(c.authorType, c.authorBotId)}) ${this.boards.forBot(board.id, c.body)}`,
            )
            .join('\n')}`
        : 'Comments: none',
    ]
    return toolText(lines.join('\n'), false, { detail: card.title })
  }

  private async comment(ctx: ToolExecContext, a: ToolArgs): Promise<ToolResult> {
    const card = this.boards.resolveCard(textArg(a, 'card'), true)
    const text = textArg(a, 'text')
    if (!text) throw new ToolInputError('"text" is required')
    if (text.length > BOARD_LIMITS.botComment)
      return toolError(
        `Keep comments under ${BOARD_LIMITS.botComment} characters: only decisions, deviations and blockers, not a summary of the work.`,
      )
    const board = this.boards.resolveBoard(card.board_id)
    const imported = await this.boards.images.importMarkdown(board, text)
    this.boards.addComment(card.id, { type: 'bot', botId: ctx.bot.id }, imported.text)
    return toolText(`Commented on "${card.title}".${this.problemsText(imported.problems)}`, false, {
      detail: card.title,
    })
  }

  private link(_ctx: ToolExecContext, a: ToolArgs): ToolResult {
    const card = this.boards.resolveCard(textArg(a, 'card'), true)
    const kind = BoardCardLinkKind.safeParse(a.kind)
    if (!kind.success) throw new ToolInputError('"kind" must be plan, session, design, pr, commit or url')
    const target = this.boards.linkTarget(kind.data, textArg(a, 'ref'))
    if ('problem' in target) return toolError(target.problem)
    if (a.remove === true) {
      const removed = this.boards.removeLink(card.id, kind.data, target.ref)
      return toolText(
        removed ? `Removed the link from "${card.title}".` : `"${card.title}" had no such link.`,
        false,
        {
          detail: card.title,
        },
      )
    }
    if (this.store.links(card.id).length >= BOARD_LIMITS.links)
      return toolError(`A card holds at most ${BOARD_LIMITS.links} links.`)
    const label = clipped(a.label, 200, 'label')
    const link = this.boards.addLink(card.id, { kind: kind.data, ...target, ...(label ? { label } : {}) })
    return toolText(`Linked ${this.linkText(link)} to "${card.title}".`, false, { detail: card.title })
  }

  private async search(ctx: ToolExecContext, a: ToolArgs): Promise<ToolResult> {
    const query = textArg(a, 'query')
    if (!query) throw new ToolInputError('"query" is required')
    const hits = await this.boards.search(query, {
      archived: a.archived === true,
      projectFilter: this.projectFilter(ctx, a),
    })
    if (!hits.length) return toolText(`No board or card matches "${query}".`, false, { detail: query })
    const lines = hits.map(({ board, card }) => {
      if (!card) return this.boardLine(board)
      return (
        `- card ${card.title} [${card.status}] (${card.id}) on "${board.title}" (${board.id})` +
        `${board.archived_at !== null ? ' · archived board' : ''} · ${date(card.updated_at)}` +
        (card.summary ? ` — ${oneLine(card.summary, 200)}` : '')
      )
    })
    return toolText(`${lines.join('\n')}\n\nOpen one with board_get or board_card_get.`, false, {
      detail: query,
    })
  }
}
