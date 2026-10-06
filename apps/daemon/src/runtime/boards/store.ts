import {
  applyCardMove,
  type Board,
  type BoardCard,
  type BoardCardLink,
  type BoardCardLinkKind,
  type BoardCardStatus,
  type BoardComment,
  type BoardCounts,
  type BoardLabel,
  type BoardLabelColor,
  type BoardStatus,
  columnCards,
  newId,
} from '@milibot/shared'

import { type Db, sqlList } from '../../db/sqlite'

export function countCards(cards: readonly { status: BoardCardStatus }[]): BoardCounts {
  const counts: BoardCounts = { todo: 0, doing: 0, done: 0, dropped: 0 }
  for (const card of cards) counts[card.status] += 1
  return counts
}

/** Done once it has cards and none is left to do or in progress. */
export function boardStatusOf(counts: BoardCounts): BoardStatus {
  const total = counts.todo + counts.doing + counts.done + counts.dropped
  return total > 0 && counts.todo + counts.doing === 0 ? 'done' : 'active'
}

export interface BoardRow {
  seq: number
  id: string
  title: string
  summary: string
  project_id: string | null
  bot_id: string | null
  conversation_id: string | null
  message_id: string | null
  due_date: string | null
  completed_at: number | null
  archived_at: number | null
  position: number
  doing_limit: number | null
  created_at: number
  updated_at: number
}

export interface CardRow {
  seq: number
  id: string
  board_id: string
  title: string
  summary: string
  body: string
  status: BoardCardStatus
  position: number
  due_date: string | null
  created_by_bot_id: string | null
  status_changed_at: number
  created_at: number
  updated_at: number
}

interface LinkRow {
  id: string
  card_id: string
  kind: BoardCardLinkKind
  ref: string
  label: string
  url: string | null
  state: string | null
  created_at: number
}

interface CommentRow {
  id: string
  card_id: string
  author_type: 'user' | 'bot'
  author_bot_id: string | null
  body: string
  created_at: number
}

interface LabelRow {
  id: string
  board_id: string
  name: string
  color: BoardLabelColor
}

function toLabel(row: LabelRow): BoardLabel {
  return { id: row.id, boardId: row.board_id, name: row.name, color: row.color }
}

/** Groups `(card_id, value)` rows by card. */
function byCard(rows: Array<{ card_id: string; value: string }>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const row of rows) out.set(row.card_id, [...(out.get(row.card_id) ?? []), row.value])
  return out
}

export interface ImageRow {
  board_id: string
  sha256: string
  name: string
  path: string
  copied: number
  created_at: number
}

/** `![name](asset:<sha>)` references of a markdown text. */
export const ASSET_IMAGE = /!\[([^\]]*)\]\(asset:([0-9a-f]{64})\)/g

export function assetShas(text: string): string[] {
  return [...text.matchAll(ASSET_IMAGE)].map((m) => m[2] as string)
}

function toLink(row: LinkRow): BoardCardLink {
  return {
    id: row.id,
    kind: row.kind,
    ref: row.ref,
    label: row.label,
    url: row.url,
    state: row.state,
    createdAt: row.created_at,
  }
}

function toComment(row: CommentRow): BoardComment {
  return {
    id: row.id,
    cardId: row.card_id,
    authorType: row.author_type,
    authorBotId: row.author_bot_id,
    body: row.body,
    createdAt: row.created_at,
  }
}

/** Rows of `boards`, `board_cards`, `board_card_links`, `board_comments` and `board_images`. */
export class BoardStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  /** Titles of the boards among `ids` (archived ones too). */
  boardNames(ids: readonly string[]): Array<{ id: string; name: string }> {
    if (!ids.length) return []
    return this.db
      .prepare(`SELECT id, title AS name FROM boards WHERE id IN (${sqlList(ids)})`)
      .all(...ids) as Array<{ id: string; name: string }>
  }

  /** Titles of the cards among `ids`, with their boards. */
  cardNames(ids: readonly string[]): Array<{ id: string; name: string; boardId: string }> {
    if (!ids.length) return []
    return this.db
      .prepare(`SELECT id, title AS name, board_id AS boardId FROM board_cards WHERE id IN (${sqlList(ids)})`)
      .all(...ids) as Array<{ id: string; name: string; boardId: string }>
  }

  board(id: string): BoardRow | null {
    return (this.db.prepare('SELECT * FROM boards WHERE id = ?').get(id) as BoardRow | undefined) ?? null
  }

  /** In the boards' order (`position`, never the last change); archived ones only with `archived`. */
  boards(filter: { archived?: boolean } = {}): BoardRow[] {
    return this.db
      .prepare(
        `SELECT * FROM boards ${filter.archived ? '' : 'WHERE archived_at IS NULL'} ORDER BY position, seq DESC`,
      )
      .all() as BoardRow[]
  }

  /** Puts a board at `index` (clamped) among every board, renumbering them from 0; the ids that moved. */
  reorderBoard(id: string, index: number): string[] {
    const ids = this.boards({ archived: true }).map((b) => b.id)
    if (!ids.includes(id)) return []
    const rest = ids.filter((b) => b !== id)
    rest.splice(Math.max(0, Math.min(index, rest.length)), 0, id)
    return this.renumberBoards(rest)
  }

  private renumberBoards(ordered: readonly string[]): string[] {
    const current = new Map(this.boards({ archived: true }).map((b) => [b.id, b.position]))
    const update = this.db.prepare('UPDATE boards SET position = ? WHERE id = ?')
    const changed = ordered.filter((id, i) => current.get(id) !== i)
    this.db.transaction(() => {
      ordered.forEach((id, i) => {
        if (current.get(id) !== i) update.run(i, id)
      })
    })()
    return changed
  }

  insertBoard(input: {
    title: string
    summary: string
    projectId: string | null
    botId: string | null
    conversationId: string | null
    dueDate: string | null
  }): BoardRow {
    const id = newId('board')
    const now = this.now()
    // A new board goes on top.
    this.db.transaction(() => {
      this.db.prepare('UPDATE boards SET position = position + 1').run()
      this.db
        .prepare(
          `INSERT INTO boards (id, title, summary, project_id, bot_id, conversation_id, due_date, position,
            created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          id,
          input.title,
          input.summary,
          input.projectId,
          input.botId,
          input.conversationId,
          input.dueDate,
          now,
          now,
        )
    })()
    return this.board(id) as BoardRow
  }

  updateBoard(id: string, patch: Partial<Omit<BoardRow, 'seq' | 'id' | 'created_at'>>): BoardRow {
    const entries = Object.entries({ ...patch, updated_at: patch.updated_at ?? this.now() })
    this.db
      .prepare(`UPDATE boards SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...entries.map(([, v]) => v), id)
    return this.board(id) as BoardRow
  }

  deleteBoard(id: string): string[] {
    const cardIds = this.cards(id).map((c) => c.id)
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM boards WHERE id = ?').run(id)
      this.db
        .prepare('DELETE FROM board_vectors WHERE item_id IN (SELECT value FROM json_each(?))')
        .run(JSON.stringify([id, ...cardIds]))
    })()
    return cardIds
  }

  /** Sets or clears `completed_at` from the cards; true when it changed. */
  syncCompletion(id: string): boolean {
    const row = this.board(id)
    if (!row) return false
    const done = boardStatusOf(countCards(this.cards(id))) === 'done'
    if (done === (row.completed_at !== null)) return false
    this.db.prepare('UPDATE boards SET completed_at = ? WHERE id = ?').run(done ? this.now() : null, id)
    return true
  }

  toBoard(row: BoardRow): Board {
    const counts = countCards(this.cards(row.id))
    return {
      id: row.id,
      title: row.title,
      summary: row.summary,
      projectId: row.project_id,
      botId: row.bot_id,
      conversationId: row.conversation_id,
      status: boardStatusOf(counts),
      counts,
      dueDate: row.due_date,
      labels: this.labels(row.id),
      position: row.position,
      doingLimit: row.doing_limit,
      completedAt: row.completed_at,
      archivedAt: row.archived_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  card(id: string): CardRow | null {
    return (this.db.prepare('SELECT * FROM board_cards WHERE id = ?').get(id) as CardRow | undefined) ?? null
  }

  cards(boardId: string): CardRow[] {
    return this.db
      .prepare('SELECT * FROM board_cards WHERE board_id = ? ORDER BY status, position, seq')
      .all(boardId) as CardRow[]
  }

  /** Cards of boards that are not archived (and of archived ones with `archived`). */
  allCards(filter: { archived?: boolean } = {}): CardRow[] {
    return this.db
      .prepare(
        `SELECT c.* FROM board_cards c JOIN boards b ON b.id = c.board_id
         ${filter.archived ? '' : 'WHERE b.archived_at IS NULL'} ORDER BY c.updated_at DESC`,
      )
      .all() as CardRow[]
  }

  insertCard(
    boardId: string,
    input: {
      title: string
      summary: string
      body: string
      status: BoardCardStatus
      dueDate: string | null
      createdByBotId: string | null
    },
  ): CardRow {
    const id = newId('boardCard')
    const now = this.now()
    const position = columnCards(this.cards(boardId), input.status).length
    this.db
      .prepare(
        `INSERT INTO board_cards (id, board_id, title, summary, body, status, position, due_date,
          created_by_bot_id, status_changed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        boardId,
        input.title,
        input.summary,
        input.body,
        input.status,
        position,
        input.dueDate,
        input.createdByBotId,
        now,
        now,
        now,
      )
    return this.card(id) as CardRow
  }

  updateCard(id: string, patch: Partial<Omit<CardRow, 'seq' | 'id' | 'board_id' | 'created_at'>>): CardRow {
    const entries = Object.entries({ ...patch, updated_at: patch.updated_at ?? this.now() })
    this.db
      .prepare(`UPDATE board_cards SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...entries.map(([, v]) => v), id)
    return this.card(id) as CardRow
  }

  /** Saves the status and position of the cards that changed. */
  savePlaces(before: readonly CardRow[], after: readonly CardRow[]): void {
    const old = new Map(before.map((c) => [c.id, c]))
    const now = this.now()
    const update = this.db.prepare(
      'UPDATE board_cards SET status = ?, position = ?, status_changed_at = ?, updated_at = ? WHERE id = ?',
    )
    this.db.transaction(() => {
      for (const card of after) {
        const prev = old.get(card.id)
        if (!prev || (prev.status === card.status && prev.position === card.position)) continue
        const moved = prev.status !== card.status
        update.run(
          card.status,
          card.position,
          moved ? now : prev.status_changed_at,
          moved ? now : prev.updated_at,
          card.id,
        )
      }
    })()
  }

  /**
   * Moves a card to another board, keeping its id, comments, links and assignees: its labels are matched by
   * name on the target (missing ones created with the same color), `images` are the target's rows for the
   * images its texts show, and both columns get dense positions. Without `keepLabels` it lands with none.
   */
  moveCardToBoard(
    cardId: string,
    toBoardId: string,
    status: BoardCardStatus,
    index: number,
    images: ReadonlyArray<{ sha256: string; name: string; path: string }>,
    keepLabels = true,
  ): void {
    const card = this.card(cardId)
    if (!card) return
    const labels = keepLabels ? this.cardLabelIds(cardId).flatMap((id) => this.label(id) ?? []) : []
    const now = this.now()
    this.db.transaction(() => {
      const labelIds = labels.map(
        (l) => (this.labelByName(toBoardId, l.name) ?? this.insertLabel(toBoardId, l.name, l.color)).id,
      )
      this.setCardLabels(cardId, labelIds)
      const end = columnCards(this.cards(toBoardId), status).length
      this.db
        .prepare(
          `UPDATE board_cards SET board_id = ?, status = ?, position = ?, status_changed_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(toBoardId, status, end, status === card.status ? card.status_changed_at : now, now, cardId)
      const source = this.cards(card.board_id)
      const column = columnCards(source, card.status)
      this.savePlaces(
        source,
        source.map((c) => (c.status === card.status ? { ...c, position: column.indexOf(c) } : c)),
      )
      const target = this.cards(toBoardId)
      this.savePlaces(target, applyCardMove(target, cardId, status, index))
      for (const image of images) this.putImage(toBoardId, image.sha256, image.name, image.path)
    })()
  }

  deleteCard(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM board_cards WHERE id = ?').run(id)
      this.db.prepare('DELETE FROM board_vectors WHERE item_id = ?').run(id)
    })()
  }

  toCards(boardId: string): BoardCard[] {
    const rows = this.cards(boardId)
    const links = this.linksOfBoard(boardId)
    const comments = new Map(
      (
        this.db
          .prepare(
            `SELECT card_id, COUNT(*) AS n FROM board_comments WHERE card_id IN
             (SELECT id FROM board_cards WHERE board_id = ?) GROUP BY card_id`,
          )
          .all(boardId) as Array<{ card_id: string; n: number }>
      ).map((r) => [r.card_id, r.n]),
    )
    const assignees = byCard(
      this.db
        .prepare(
          `SELECT a.card_id, a.assignee AS value FROM board_card_assignees a JOIN board_cards c ON c.id = a.card_id
           WHERE c.board_id = ? ORDER BY a.created_at, a.rowid`,
        )
        .all(boardId) as Array<{ card_id: string; value: string }>,
    )
    const labels = byCard(
      this.db
        .prepare(
          `SELECT cl.card_id, cl.label_id AS value FROM board_card_labels cl JOIN board_labels l ON l.id = cl.label_id
           WHERE l.board_id = ? ORDER BY l.created_at, l.id`,
        )
        .all(boardId) as Array<{ card_id: string; value: string }>,
    )
    return rows.map((row) =>
      this.toCard(row, {
        links: links.get(row.id) ?? [],
        commentCount: comments.get(row.id) ?? 0,
        assignees: assignees.get(row.id) ?? [],
        labelIds: labels.get(row.id) ?? [],
      }),
    )
  }

  toCard(
    row: CardRow,
    known: {
      links: BoardCardLink[]
      commentCount: number
      assignees: string[]
      labelIds: string[]
    } | null = null,
  ): BoardCard {
    return {
      id: row.id,
      boardId: row.board_id,
      title: row.title,
      summary: row.summary,
      status: row.status,
      position: row.position,
      dueDate: row.due_date,
      assignees: known?.assignees ?? this.assignees(row.id),
      labelIds: known?.labelIds ?? this.cardLabelIds(row.id),
      createdByBotId: row.created_by_bot_id,
      commentCount: known?.commentCount ?? this.comments(row.id).length,
      imageCount: new Set(assetShas(row.body)).size,
      links: known?.links ?? this.links(row.id),
      statusChangedAt: row.status_changed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  assignees(cardId: string): string[] {
    return (
      this.db
        .prepare('SELECT assignee FROM board_card_assignees WHERE card_id = ? ORDER BY created_at, rowid')
        .all(cardId) as Array<{ assignee: string }>
    ).map((r) => r.assignee)
  }

  /** Replaces the assignees, keeping when those already there were added. */
  setAssignees(cardId: string, assignees: readonly string[]): void {
    const keep = new Set(assignees)
    this.db.transaction(() => {
      for (const current of this.assignees(cardId))
        if (!keep.has(current))
          this.db
            .prepare('DELETE FROM board_card_assignees WHERE card_id = ? AND assignee = ?')
            .run(cardId, current)
      for (const assignee of assignees) this.addAssignee(cardId, assignee)
    })()
  }

  addAssignee(cardId: string, assignee: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO board_card_assignees (card_id, assignee, created_at) VALUES (?, ?, ?)')
      .run(cardId, assignee, this.now())
  }

  labels(boardId: string): BoardLabel[] {
    return (
      this.db
        .prepare('SELECT * FROM board_labels WHERE board_id = ? ORDER BY created_at, id')
        .all(boardId) as LabelRow[]
    ).map(toLabel)
  }

  label(id: string): BoardLabel | null {
    const row = this.db.prepare('SELECT * FROM board_labels WHERE id = ?').get(id) as LabelRow | undefined
    return row ? toLabel(row) : null
  }

  labelByName(boardId: string, name: string): BoardLabel | null {
    const row = this.db
      .prepare('SELECT * FROM board_labels WHERE board_id = ? AND name = ? COLLATE NOCASE')
      .get(boardId, name) as LabelRow | undefined
    return row ? toLabel(row) : null
  }

  insertLabel(boardId: string, name: string, color: BoardLabelColor): BoardLabel {
    const id = newId('boardLabel')
    this.db
      .prepare('INSERT INTO board_labels (id, board_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, boardId, name, color, this.now())
    return this.label(id) as BoardLabel
  }

  updateLabel(id: string, patch: { name?: string; color?: BoardLabelColor }): BoardLabel {
    if (patch.name !== undefined)
      this.db.prepare('UPDATE board_labels SET name = ? WHERE id = ?').run(patch.name, id)
    if (patch.color !== undefined)
      this.db.prepare('UPDATE board_labels SET color = ? WHERE id = ?').run(patch.color, id)
    return this.label(id) as BoardLabel
  }

  deleteLabel(id: string): void {
    this.db.prepare('DELETE FROM board_labels WHERE id = ?').run(id)
  }

  cardLabelIds(cardId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT cl.label_id FROM board_card_labels cl JOIN board_labels l ON l.id = cl.label_id
           WHERE cl.card_id = ? ORDER BY l.created_at, l.id`,
        )
        .all(cardId) as Array<{ label_id: string }>
    ).map((r) => r.label_id)
  }

  setCardLabels(cardId: string, labelIds: readonly string[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM board_card_labels WHERE card_id = ?').run(cardId)
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO board_card_labels (card_id, label_id) VALUES (?, ?)',
      )
      for (const id of labelIds) insert.run(cardId, id)
    })()
  }

  links(cardId: string): BoardCardLink[] {
    return (
      this.db
        .prepare('SELECT * FROM board_card_links WHERE card_id = ? ORDER BY created_at, id')
        .all(cardId) as LinkRow[]
    ).map(toLink)
  }

  private linksOfBoard(boardId: string): Map<string, BoardCardLink[]> {
    const out = new Map<string, BoardCardLink[]>()
    for (const row of this.db
      .prepare(
        `SELECT l.* FROM board_card_links l JOIN board_cards c ON c.id = l.card_id WHERE c.board_id = ?
         ORDER BY l.created_at, l.id`,
      )
      .all(boardId) as LinkRow[]) {
      const list = out.get(row.card_id) ?? []
      list.push(toLink(row))
      out.set(row.card_id, list)
    }
    return out
  }

  /** Adds a link, or updates the label, URL and state of the same one. */
  putLink(
    cardId: string,
    link: { kind: BoardCardLinkKind; ref: string; label: string; url?: string | null; state?: string | null },
  ): BoardCardLink {
    const existing = this.db
      .prepare('SELECT * FROM board_card_links WHERE card_id = ? AND kind = ? AND ref = ?')
      .get(cardId, link.kind, link.ref) as LinkRow | undefined
    if (existing) {
      this.db
        .prepare('UPDATE board_card_links SET label = ?, url = ?, state = ? WHERE id = ?')
        .run(link.label, link.url ?? existing.url, link.state ?? existing.state, existing.id)
      return this.link(existing.id) as BoardCardLink
    }
    const id = newId('boardLink')
    this.db
      .prepare(
        'INSERT INTO board_card_links (id, card_id, kind, ref, label, url, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, cardId, link.kind, link.ref, link.label, link.url ?? null, link.state ?? null, this.now())
    return this.link(id) as BoardCardLink
  }

  link(id: string): BoardCardLink | null {
    const row = this.db.prepare('SELECT * FROM board_card_links WHERE id = ?').get(id) as LinkRow | undefined
    return row ? toLink(row) : null
  }

  linkCard(linkId: string): string | null {
    const row = this.db.prepare('SELECT card_id FROM board_card_links WHERE id = ?').get(linkId) as
      { card_id: string } | undefined
    return row?.card_id ?? null
  }

  /** Pull request links not merged yet on boards that are not archived, newest first. */
  openPullRequestLinks(): Array<{ id: string; boardId: string; url: string; state: string | null }> {
    return (
      this.db
        .prepare(
          `SELECT l.id, c.board_id, coalesce(l.url, l.ref) AS url, l.state FROM board_card_links l
           JOIN board_cards c ON c.id = l.card_id JOIN boards b ON b.id = c.board_id
           WHERE l.kind = 'pr' AND coalesce(l.state, '') != 'done' AND b.archived_at IS NULL
           ORDER BY l.created_at DESC, l.id DESC`,
        )
        .all() as Array<{ id: string; board_id: string; url: string; state: string | null }>
    ).map((row) => ({ id: row.id, boardId: row.board_id, url: row.url, state: row.state }))
  }

  setLinkState(id: string, state: string): void {
    this.db.prepare('UPDATE board_card_links SET state = ? WHERE id = ?').run(state, id)
  }

  removeLink(id: string): void {
    this.db.prepare('DELETE FROM board_card_links WHERE id = ?').run(id)
  }

  removeLinkByRef(cardId: string, kind: BoardCardLinkKind, ref: string): boolean {
    return (
      this.db
        .prepare('DELETE FROM board_card_links WHERE card_id = ? AND kind = ? AND ref = ?')
        .run(cardId, kind, ref).changes > 0
    )
  }

  /** Cards linked to a plan, session or design, newest link first. */
  cardsLinkedTo(kind: BoardCardLinkKind, ref: string): string[] {
    return (
      this.db
        .prepare('SELECT card_id FROM board_card_links WHERE kind = ? AND ref = ? ORDER BY created_at DESC')
        .all(kind, ref) as Array<{ card_id: string }>
    ).map((r) => r.card_id)
  }

  comments(cardId: string): BoardComment[] {
    return (
      this.db
        .prepare('SELECT * FROM board_comments WHERE card_id = ? ORDER BY created_at, id')
        .all(cardId) as CommentRow[]
    ).map(toComment)
  }

  addComment(
    cardId: string,
    author: { type: 'user' | 'bot'; botId: string | null },
    body: string,
  ): BoardComment {
    const id = newId('boardComment')
    this.db
      .prepare(
        'INSERT INTO board_comments (id, card_id, author_type, author_bot_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, cardId, author.type, author.botId, body, this.now())
    return toComment(this.db.prepare('SELECT * FROM board_comments WHERE id = ?').get(id) as CommentRow)
  }

  comment(id: string): BoardComment | null {
    const row = this.db.prepare('SELECT * FROM board_comments WHERE id = ?').get(id) as CommentRow | undefined
    return row ? toComment(row) : null
  }

  deleteComment(id: string): void {
    this.db.prepare('DELETE FROM board_comments WHERE id = ?').run(id)
  }

  image(boardId: string, sha: string): ImageRow | null {
    return (
      (this.db.prepare('SELECT * FROM board_images WHERE board_id = ? AND sha256 = ?').get(boardId, sha) as
        ImageRow | undefined) ?? null
    )
  }

  putImage(boardId: string, sha: string, name: string, path: string): ImageRow {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO board_images (board_id, sha256, name, path, copied, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
      )
      .run(boardId, sha, name, path, this.now())
    return this.image(boardId, sha) as ImageRow
  }

  /** Images not in the VM yet, oldest first. */
  uncopiedImages(): ImageRow[] {
    return this.db
      .prepare('SELECT * FROM board_images WHERE copied = 0 ORDER BY created_at')
      .all() as ImageRow[]
  }

  markCopied(boardId: string, sha: string): void {
    this.db.prepare('UPDATE board_images SET copied = 1 WHERE board_id = ? AND sha256 = ?').run(boardId, sha)
  }

  /** Blobs the boards' images keep (debug retention must not remove them). */
  referencedBlobs(): string[] {
    return (
      this.db.prepare('SELECT DISTINCT sha256 FROM board_images').all() as Array<{ sha256: string }>
    ).map((r) => r.sha256)
  }
}
