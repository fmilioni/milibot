import type { BlobStore, NewAgentMessage } from '@milibot/agent'
import { ToolInputError } from '@milibot/agent/tools'
import {
  applyCardMove,
  type Board,
  BOARD_LABEL_COLORS,
  BOARD_LIMITS,
  BOARD_USER,
  type BoardCardDetail,
  type BoardCardLink,
  type BoardCardLinkKind,
  type BoardCardStatus,
  type BoardDetail,
  type BoardImage,
  type BoardLabel,
  type BoardLabelColor,
  type BoardListFilter,
  type BoardPayload,
  type Bot,
  type Language,
  type LogFn,
  type Message,
  type MessagePayload,
  type TaskPayload,
  type WorkspaceEvent,
} from '@milibot/shared'

import type { Db } from '../../db/sqlite'
import { DaemonError, errorMessage, notFound } from '../../errors'
import type { EmbeddingService } from '../embeddings'
import { pullRequestKey } from '../tasks'
import { resolveByRef } from '../tools-core'
import type { VmController } from '../vm'
import { BoardImages } from './images'
import { type BoardCardLinks, type LinkTarget, linkTarget, type LinkTargets } from './links'
import { BOARD_CORPUS, boardCorpus, searchBoardItems } from './search'
import { assetShas, type BoardRow, BoardStore, type CardRow } from './store'

/** Color for a new label: the one the board's labels use least (in palette order on a tie). */
function nextLabelColor(labels: ReadonlyArray<Pick<BoardLabel, 'color'>>): BoardLabelColor {
  const uses = (color: BoardLabelColor) => labels.filter((l) => l.color === color).length
  return BOARD_LABEL_COLORS.slice(1).reduce((best, color) => (uses(color) < uses(best) ? color : best), 'red')
}

// Portuguese on purpose: the move comment is written into the card in the user's language.
function movedNote(from: string, to: string, language: Language): string {
  return language === 'pt-BR' ? `Movido de "${from}" para "${to}".` : `Moved from "${from}" to "${to}".`
}

export interface BoardServiceDeps {
  db: Db
  vm: Pick<VmController, 'status' | 'subscribe' | 'runningGuest' | 'guest'>
  blobs: BlobStore & { get(sha: string): Promise<{ mediaType: string; bytes: Uint8Array }> }
  embeddings: EmbeddingService
  getBot: (id: string) => Bot | null
  /** Plans, work sessions and designs a card can link to. */
  linkTargets: LinkTargets
  appendMessage: (message: NewAgentMessage) => Message
  updateMessage: (id: string, patch: { content?: string; payload?: MessagePayload | null }) => Message
  emit: (event: WorkspaceEvent) => void
  /** The work session a conversation belongs to (pull requests opened there go to its card). */
  sessionOfConversation?: (conversationId: string) => string | null
  imageFetch?: (url: string, init?: RequestInit) => Promise<Response>
  /** Language of the notes the app writes on cards (the move comment). */
  userLanguage?: () => Language
  now: () => number
  log?: LogFn
}

/**
 * Boards: kanban boards bots plan large goals on. Owns the rows, the chat card of each
 * board, the images of its cards and the search index.
 */
export class BoardService implements BoardCardLinks {
  readonly store: BoardStore
  readonly images: BoardImages

  constructor(private readonly deps: BoardServiceDeps) {
    this.store = new BoardStore(deps.db, deps.now)
    this.images = new BoardImages({ ...deps, store: this.store })
    deps.embeddings.addCorpus(boardCorpus(deps.db))
  }

  start(): void {
    this.images.start()
  }

  stop(): Promise<void> {
    return this.images.stop()
  }

  /** Blobs the boards' images keep (debug retention must not remove them). */
  referencedBlobs(): string[] {
    return this.store.referencedBlobs()
  }

  /** A board by id or title; archived ones only by id or exact title, and `write` refuses them. */
  resolveBoard(ref: string, write = false): BoardRow {
    if (!ref) throw new ToolInputError('"board" is required (its title or id)')
    const match = resolveByRef(this.store.boards({ archived: true }), ref, {
      id: (row) => row.id,
      names: (row) => [row.title],
      partialAllowed: (row) => row.archived_at === null,
      ambiguous: { exact: 'first', partial: 'report' },
    })
    if (!('found' in match))
      throw new DaemonError('not_found', `There is no board "${ref}" (board_list lists them).`)
    const row = match.found
    if (write && row.archived_at !== null)
      throw new DaemonError(
        'conflict',
        `The board "${row.title}" is archived; unarchive it with board_update first.`,
      )
    return row
  }

  /** A card by id, or by title among the cards of boards that are not archived. */
  resolveCard(ref: string, write = false): CardRow {
    if (!ref) throw new ToolInputError('"card" is required (its title or id)')
    let card = this.store.card(ref)
    if (!card) {
      const match = resolveByRef(this.store.allCards(), ref, {
        id: (row) => row.id,
        names: (row) => [row.title],
        ambiguous: { exact: 'report', partial: 'report' },
      })
      if ('ambiguous' in match)
        throw new DaemonError(
          'conflict',
          `Several cards match "${ref}": ${match.ambiguous
            .slice(0, 8)
            .map((c) => `"${c.title}" (${c.id})`)
            .join(', ')}. Name it by id.`,
        )
      card = 'found' in match ? match.found : null
    }
    if (!card)
      throw new DaemonError('not_found', `There is no card "${ref}" (board_get lists a board's cards).`)
    if (write) this.resolveBoard(card.board_id, true)
    return card
  }

  linkTarget(kind: BoardCardLinkKind, ref: string): LinkTarget {
    return linkTarget(this.deps.linkTargets, kind, ref)
  }

  requireBoard(id: string): BoardRow {
    const row = this.store.board(id)
    if (!row) throw notFound('board', id)
    return row
  }

  requireCard(id: string, boardId?: string): CardRow {
    const row = this.store.card(id)
    if (!row || (boardId && row.board_id !== boardId)) throw notFound('card', id)
    return row
  }

  board(row: BoardRow): Board {
    return this.store.toBoard(row)
  }

  detail(row: BoardRow): BoardDetail {
    return { ...this.store.toBoard(row), cards: this.store.toCards(row.id) }
  }

  cardDetail(row: CardRow): BoardCardDetail {
    return { ...this.store.toCard(row), body: row.body, comments: this.store.comments(row.id) }
  }

  list(filter: BoardListFilter = 'all', projectId?: string): Board[] {
    return this.store
      .boards({ archived: filter === 'archived' || filter === 'all' })
      .map((r) => this.store.toBoard(r))
      .filter((b) => {
        if (projectId && b.projectId !== projectId) return false
        if (filter === 'archived') return b.archivedAt !== null
        if (filter === 'active' || filter === 'done') return b.archivedAt === null && b.status === filter
        return true
      })
  }

  cardPayload(row: BoardRow, removed = false): BoardPayload {
    const board = this.store.toBoard(row)
    return {
      type: 'board',
      boardId: row.id,
      botId: row.bot_id ?? '',
      title: row.title,
      summary: row.summary,
      status: board.status,
      counts: board.counts,
      dueDate: row.due_date,
      ...(row.archived_at !== null ? { archived: true } : {}),
      ...(removed ? { removed: true } : {}),
    }
  }

  private updateChatCard(row: BoardRow, removed = false): void {
    if (!row.message_id) return
    try {
      this.deps.updateMessage(row.message_id, {
        content: `Board: ${row.title}`,
        payload: this.cardPayload(row, removed),
      })
    } catch (err) {
      this.deps.log?.('warn', 'board card update failed', { boardId: row.id, err: errorMessage(err) })
    }
  }

  /**
   * Announces a board after a change: its row (and cards when they changed) and its chat card. It never moves
   * the board in the list (that order is `position`), since it also runs for pull request polls.
   */
  changed(boardId: string, options: { cards?: boolean; reindex?: string[] } = {}): Board {
    this.store.syncCompletion(boardId)
    const row = this.store.updateBoard(boardId, {})
    const board = this.store.toBoard(row)
    if (options.cards)
      this.deps.emit({
        type: 'board.cards.updated',
        payload: { boardId, cards: this.store.toCards(boardId) },
      })
    this.deps.emit({ type: 'board.updated', payload: { board } })
    this.updateChatCard(row)
    if (options.reindex?.length) this.reindex(options.reindex)
    return board
  }

  private reindex(ids: string[]): void {
    void this.deps.embeddings
      .refreshCorpus(BOARD_CORPUS, ids)
      .catch((err: unknown) => this.deps.log?.('warn', 'board embedding failed', { err: errorMessage(err) }))
  }

  createBoard(input: {
    title: string
    summary: string
    projectId: string | null
    dueDate: string | null
    bot: Bot | null
    conversationId: string | null
    turnId?: string | null
  }): BoardRow {
    let row = this.store.insertBoard({
      title: input.title,
      summary: input.summary,
      projectId: input.projectId,
      botId: input.bot?.id ?? null,
      conversationId: input.conversationId,
      dueDate: input.dueDate,
    })
    if (input.bot && input.conversationId) {
      const message = this.deps.appendMessage({
        conversationId: input.conversationId,
        authorType: 'bot',
        authorBotId: input.bot.id,
        kind: 'card',
        content: `Board: ${row.title}`,
        payload: this.cardPayload(row),
        turnId: input.turnId ?? null,
      })
      row = this.store.updateBoard(row.id, { message_id: message.id, updated_at: row.updated_at })
    }
    return row
  }

  updateBoard(
    id: string,
    patch: {
      title?: string
      summary?: string
      projectId?: string | null
      dueDate?: string | null
      archived?: boolean
      doingLimit?: number | null
    },
  ): Board {
    const row = this.requireBoard(id)
    if (
      patch.doingLimit !== undefined &&
      patch.doingLimit !== null &&
      (!Number.isInteger(patch.doingLimit) ||
        patch.doingLimit < 1 ||
        patch.doingLimit > BOARD_LIMITS.doingLimit)
    )
      throw new DaemonError(
        'validation_failed',
        `The Doing limit goes from 1 to ${BOARD_LIMITS.doingLimit} cards.`,
      )
    this.store.updateBoard(id, {
      ...(patch.doingLimit !== undefined ? { doing_limit: patch.doingLimit } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.projectId !== undefined ? { project_id: patch.projectId } : {}),
      ...(patch.dueDate !== undefined ? { due_date: patch.dueDate } : {}),
      ...(patch.archived !== undefined
        ? { archived_at: patch.archived ? (row.archived_at ?? this.deps.now()) : null }
        : {}),
    })
    return this.changed(id, { reindex: patch.title !== undefined || patch.summary !== undefined ? [id] : [] })
  }

  /** Puts a board at `index` among every board (archived included) and announces the boards that moved. */
  reorderBoard(id: string, index: number): Board[] {
    this.requireBoard(id)
    for (const moved of this.store.reorderBoard(id, index)) {
      const row = this.store.board(moved)
      if (row) this.deps.emit({ type: 'board.updated', payload: { board: this.store.toBoard(row) } })
    }
    return this.list('all')
  }

  /** How far the Doing column is past the board's limit (0 when within it or without one). */
  doingOverLimit(boardId: string): { doing: number; limit: number } | null {
    const row = this.store.board(boardId)
    if (!row?.doing_limit) return null
    const doing = this.store.cards(boardId).filter((c) => c.status === 'doing').length
    return doing > row.doing_limit ? { doing, limit: row.doing_limit } : null
  }

  deleteBoard(id: string): void {
    const row = this.requireBoard(id)
    const cardIds = this.store.deleteBoard(id)
    for (const item of [id, ...cardIds]) this.deps.embeddings.forgetCorpusItem(BOARD_CORPUS, item)
    this.updateChatCard(row, true)
    this.deps.emit({ type: 'board.deleted', payload: { boardId: id } })
  }

  addCard(
    boardId: string,
    input: {
      title: string
      summary: string
      body: string
      status: BoardCardStatus
      dueDate: string | null
      createdByBotId: string | null
      assignees?: string[]
      labelIds?: string[]
      index?: number
    },
  ): CardRow {
    if (this.store.cards(boardId).length >= BOARD_LIMITS.cards)
      throw new DaemonError('conflict', `A board holds at most ${BOARD_LIMITS.cards} cards.`)
    const assignees =
      input.assignees ?? (input.status === 'doing' && input.createdByBotId ? [input.createdByBotId] : [])
    this.checkAssignees(assignees)
    if (input.labelIds) this.checkLabels(boardId, input.labelIds)
    const card = this.store.insertCard(boardId, input)
    this.store.setAssignees(card.id, assignees)
    if (input.labelIds) this.store.setCardLabels(card.id, input.labelIds)
    if (input.index !== undefined) {
      const before = this.store.cards(boardId)
      this.store.savePlaces(before, applyCardMove(before, card.id, input.status, input.index))
    }
    return this.requireCard(card.id)
  }

  updateCard(
    id: string,
    patch: {
      title?: string
      summary?: string
      body?: string
      dueDate?: string | null
      assignees?: string[]
      labelIds?: string[]
    },
  ): CardRow {
    const card = this.requireCard(id)
    if (patch.assignees) this.checkAssignees(patch.assignees)
    if (patch.labelIds) this.checkLabels(card.board_id, patch.labelIds)
    if (patch.assignees) this.store.setAssignees(id, patch.assignees)
    if (patch.labelIds) this.store.setCardLabels(id, patch.labelIds)
    return this.store.updateCard(id, {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.dueDate !== undefined ? { due_date: patch.dueDate } : {}),
    })
  }

  /** Assignees are bots of the workspace or `BOARD_USER`. */
  private checkAssignees(assignees: readonly string[]): void {
    if (assignees.length > BOARD_LIMITS.assignees)
      throw new DaemonError('validation_failed', `A card has at most ${BOARD_LIMITS.assignees} assignees.`)
    for (const assignee of assignees)
      if (assignee !== BOARD_USER && !this.deps.getBot(assignee))
        throw new DaemonError('validation_failed', `Unknown assignee "${assignee}"`, { assignee })
  }

  private checkLabels(boardId: string, labelIds: readonly string[]): void {
    for (const id of labelIds) if (this.store.label(id)?.boardId !== boardId) throw notFound('label', id)
  }

  /** Moves a card; a bot moving it to doing joins its assignees. */
  moveCard(id: string, status: BoardCardStatus, index: number, botId: string | null): CardRow {
    const card = this.requireCard(id)
    const before = this.store.cards(card.board_id)
    this.store.savePlaces(before, applyCardMove(before, id, status, index))
    if (status === 'doing' && card.status !== 'doing' && botId) this.store.addAssignee(id, botId)
    return this.requireCard(id)
  }

  /**
   * Moves a card to another board, keeping its id, comments, links (plans and sessions stay linked),
   * assignees, due date and images; labels follow by name. A comment by `author` records the move.
   */
  moveCardToBoard(
    id: string,
    toBoardId: string,
    options: {
      status?: BoardCardStatus
      index?: number
      author: { type: 'user' | 'bot'; botId: string | null }
      /** False when the caller sets the card's labels right after (the old ones would be created for nothing). */
      keepLabels?: boolean
    },
  ): CardRow {
    const card = this.requireCard(id)
    const from = this.requireBoard(card.board_id)
    const to = this.requireBoard(toBoardId)
    const status = options.status ?? card.status
    if (to.id === from.id)
      return this.moveCard(id, status, options.index ?? Number.MAX_SAFE_INTEGER, options.author.botId)
    if (to.archived_at !== null)
      throw new DaemonError('conflict', `The board "${to.title}" is archived; unarchive it first.`, {
        reason: 'archived',
      })
    if (this.store.cards(to.id).length >= BOARD_LIMITS.cards)
      throw new DaemonError('conflict', `A board holds at most ${BOARD_LIMITS.cards} cards.`, {
        reason: 'cards_limit',
      })
    const keepLabels = options.keepLabels ?? true
    const missing = (keepLabels ? this.store.cardLabelIds(id) : [])
      .flatMap((labelId) => this.store.label(labelId) ?? [])
      .filter((l) => !this.store.labelByName(to.id, l.name))
    if (this.store.labels(to.id).length + missing.length > BOARD_LIMITS.labels)
      throw new DaemonError('conflict', `A board has at most ${BOARD_LIMITS.labels} labels.`, {
        reason: 'labels_limit',
      })
    const texts = [card.body, ...this.store.comments(id).map((c) => c.body)]
    const images = [...new Set(texts.flatMap(assetShas))].flatMap((sha) => {
      const image = this.store.image(from.id, sha)
      return image ? [this.images.placeIn(to, image)] : []
    })
    this.store.moveCardToBoard(
      id,
      to.id,
      status,
      options.index ?? Number.MAX_SAFE_INTEGER,
      images,
      keepLabels,
    )
    if (status === 'doing' && card.status !== 'doing' && options.author.botId)
      this.store.addAssignee(id, options.author.botId)
    this.store.addComment(
      id,
      options.author,
      movedNote(from.title, to.title, this.deps.userLanguage?.() ?? 'en'),
    )
    if (images.length) this.images.kick()
    this.changed(from.id, { cards: true })
    this.changed(to.id, { cards: true })
    return this.requireCard(id)
  }

  addLabel(boardId: string, name: string, color?: BoardLabelColor): BoardLabel {
    const labels = this.store.labels(boardId)
    if (this.store.labelByName(boardId, name))
      throw new DaemonError('conflict', `The board already has a label "${name}".`, { name })
    if (labels.length >= BOARD_LIMITS.labels)
      throw new DaemonError('conflict', `A board has at most ${BOARD_LIMITS.labels} labels.`)
    const label = this.store.insertLabel(boardId, name, color ?? nextLabelColor(labels))
    this.changed(boardId)
    return label
  }

  updateLabel(boardId: string, id: string, patch: { name?: string; color?: BoardLabelColor }): BoardLabel {
    if (this.store.label(id)?.boardId !== boardId) throw notFound('label', id)
    const clash = patch.name !== undefined ? this.store.labelByName(boardId, patch.name) : null
    if (clash && clash.id !== id)
      throw new DaemonError('conflict', `The board already has a label "${patch.name}".`, {
        name: patch.name,
      })
    const label = this.store.updateLabel(id, patch)
    this.changed(boardId)
    return label
  }

  deleteLabel(boardId: string, id: string): void {
    if (this.store.label(id)?.boardId !== boardId) throw notFound('label', id)
    this.store.deleteLabel(id)
    this.changed(boardId, { cards: true })
  }

  deleteCard(id: string): void {
    const card = this.requireCard(id)
    this.store.deleteCard(id)
    this.deps.embeddings.forgetCorpusItem(BOARD_CORPUS, id)
    const rest = this.store.cards(card.board_id)
    const column = rest.filter((c) => c.status === card.status).sort((a, b) => a.position - b.position)
    this.store.savePlaces(
      rest,
      rest.map((c) => (c.status === card.status ? { ...c, position: column.indexOf(c) } : c)),
    )
    this.changed(card.board_id, { cards: true })
  }

  resolveCardId(ref: string): string {
    return this.resolveCard(ref).id
  }

  /** A comment on a card, which counts as a change of the card. */
  addComment(cardId: string, author: { type: 'user' | 'bot'; botId: string | null }, body: string) {
    const card = this.requireCard(cardId)
    const comment = this.store.addComment(cardId, author, body)
    this.store.updateCard(cardId, {})
    this.changed(card.board_id, { cards: true })
    return comment
  }

  addLink(cardId: string, link: Omit<BoardCardLink, 'id' | 'createdAt' | 'state'>): BoardCardLink {
    const card = this.requireCard(cardId)
    const saved = this.store.putLink(cardId, link)
    this.changed(card.board_id, { cards: true })
    return saved
  }

  /** Removes the card's link to `ref`; false when it had none. */
  removeLink(cardId: string, kind: BoardCardLinkKind, ref: string): boolean {
    const card = this.requireCard(cardId)
    const removed = this.store.removeLinkByRef(cardId, kind, ref)
    if (removed) this.changed(card.board_id, { cards: true })
    return removed
  }

  linkPlan(cardId: string, plan: { id: string; title: string }): void {
    const card = this.requireCard(cardId)
    this.store.putLink(cardId, { kind: 'plan', ref: plan.id, label: plan.title })
    this.changed(card.board_id, { cards: true })
  }

  linkSession(cardId: string, session: { id: string; title: string }, botId: string): void {
    const card = this.requireCard(cardId)
    this.store.putLink(cardId, { kind: 'session', ref: session.id, label: session.title })
    if (card.status === 'todo') this.moveCard(cardId, 'doing', this.store.cards(card.board_id).length, botId)
    else this.store.addAssignee(cardId, botId)
    this.changed(card.board_id, { cards: true })
  }

  cardOfPlan(planId: string): string | null {
    return this.store.cardsLinkedTo('plan', planId)[0] ?? null
  }

  cardOfSession(sessionId: string): string | null {
    return this.store.cardsLinkedTo('session', sessionId)[0] ?? null
  }

  briefFor(cardId: string): string | null {
    const card = this.store.card(cardId)
    const board = card ? this.store.board(card.board_id) : null
    if (!card || !board) return null
    const comments = this.store.comments(cardId)
    return [
      `Board card: "${card.title}" (${card.id}) of the board "${board.title}" (${board.id}); read it again with board_card_get.`,
      ...(card.summary ? [card.summary] : []),
      ...(card.body.trim() ? [this.forBot(board.id, card.body)] : []),
      ...(comments.length
        ? [
            `Comments:\n${comments
              .map(
                (c) => `- ${this.authorName(c.authorType, c.authorBotId)}: ${this.forBot(board.id, c.body)}`,
              )
              .join('\n')}`,
          ]
        : []),
      'Keep the card current: comment decisions and deviations (board_comment), move it to done when finished.',
    ].join('\n\n')
  }

  /**
   * A pull request opened or changed in a work session goes to the cards that session works on; its new status
   * reaches every card already linking it.
   */
  linkPullRequest(conversationId: string, task: TaskPayload): void {
    if (!task.url) return
    const sessionId = this.deps.sessionOfConversation?.(conversationId)
    for (const cardId of sessionId ? this.store.cardsLinkedTo('session', sessionId) : []) {
      const card = this.store.card(cardId)
      if (!card) continue
      this.store.putLink(cardId, {
        kind: 'pr',
        ref: task.url,
        label: `${task.prNumber ? `#${task.prNumber} ` : ''}${task.title}`.slice(0, 200),
        url: task.url,
        state: task.status,
      })
      this.changed(card.board_id, { cards: true })
    }
    // A merge or close made from another conversation (the PM's, a gh command) reaches every card linking it.
    const key = pullRequestKey(task.url)
    if (key) this.applyPullRequestStates(new Map([[key, task.status]]))
  }

  /** URLs of the pull request links not merged yet, newest first. */
  trackedPullRequests(): string[] {
    return this.store.openPullRequestLinks().map((link) => link.url)
  }

  /** Pull request states (by `pullRequestKey`) applied to every link of those pull requests on any card. */
  applyPullRequestStates(states: Map<string, string>): void {
    const boards = new Set<string>()
    for (const link of this.store.openPullRequestLinks()) {
      const state = states.get(pullRequestKey(link.url) ?? '')
      if (!state || state === link.state) continue
      this.store.setLinkState(link.id, state)
      boards.add(link.boardId)
    }
    for (const boardId of boards) this.changed(boardId, { cards: true })
  }

  authorName(type: 'user' | 'bot', botId: string | null): string {
    if (type === 'user') return 'the user'
    return (botId && this.deps.getBot(botId)?.name) || 'a bot'
  }

  /** Text as a bot reads it: images as the VM paths it can open. */
  forBot(boardId: string, text: string): string {
    return this.images.forBot(boardId, text)
  }

  addImage(boardId: string, bytes: Uint8Array, name: string): Promise<BoardImage> {
    return this.images.add(this.requireBoard(boardId), bytes, name)
  }

  async search(
    query: string,
    options: { archived: boolean; projectFilter: (projectId: string | null) => boolean },
    limit = 12,
  ): Promise<Array<{ board: BoardRow; card: CardRow | null }>> {
    const boards = this.store
      .boards({ archived: options.archived })
      .filter((b) => options.projectFilter(b.project_id))
    const byId = new Map(boards.map((b) => [b.id, b]))
    const cards = this.store.allCards({ archived: options.archived }).filter((c) => byId.has(c.board_id))
    const cardById = new Map(cards.map((c) => [c.id, c]))
    const ids = await searchBoardItems(
      this.deps,
      query,
      {
        boards: new Map(boards.map((b) => [b.seq, b.id])),
        cards: new Map(cards.map((c) => [c.seq, c.id])),
      },
      limit,
    )
    return ids.flatMap((id) => {
      const card = cardById.get(id)
      const board = card ? byId.get(card.board_id) : byId.get(id)
      return board ? [{ board, card: card ?? null }] : []
    })
  }
}
