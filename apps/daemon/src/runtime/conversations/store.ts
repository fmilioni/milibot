import {
  type Bot,
  type ConversationSummary,
  type ConversationType,
  type GroupSettings,
  type Message,
  newId,
} from '@milibot/shared'

import { bool, type Db, parseJson, sqlList } from '../../db/sqlite'
import { DaemonError, notFound } from '../../errors'
import type { BotStore } from '../bots/store'
import { type MessageRow, toMessage } from '../messages/store'

interface ConversationRow {
  id: string
  type: ConversationType
  title: string | null
  settings: string
  project_id: string | null
  created_at: number
  updated_at: number
  last_message_at: number | null
  section_id: string | null
  position: number | null
  pinned: number | null
  hidden: number | null
  marked_unread: number | null
  last_read_seq: number | null
}

const CONVERSATION_SELECT = /* sql */ `
  SELECT c.*, s.section_id, s.position, s.pinned, s.hidden, s.marked_unread, s.last_read_seq
  FROM conversations c LEFT JOIN sidebar_items s ON s.conversation_id = c.id
  WHERE c.deleted_at IS NULL
`

export interface NewConversation {
  type: ConversationType
  botIds: string[]
  title?: string | null
  settings?: Partial<GroupSettings>
  projectId?: string | null
}

/** The `conversations` table with its members and sidebar placement. */
export class ConversationStore {
  constructor(
    private readonly db: Db,
    private readonly bots: BotStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** The conversations among `ids` (deleted ones left out), with their current members. */
  refs(
    ids: readonly string[],
  ): Array<{ id: string; type: ConversationType; title: string | null; memberBotIds: string[] }> {
    if (!ids.length) return []
    const rows = this.db
      .prepare(
        `SELECT id, type, title FROM conversations WHERE id IN (${sqlList(ids)}) AND deleted_at IS NULL`,
      )
      .all(...ids) as Array<{ id: string; type: ConversationType; title: string | null }>
    return rows.map((row) => ({ ...row, memberBotIds: this.memberBotIds(row.id) }))
  }

  private memberBotIds(conversationId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT bot_id FROM conversation_members
         WHERE conversation_id = ? AND bot_id IS NOT NULL AND left_at IS NULL ORDER BY joined_at, bot_id`,
      )
      .all(conversationId) as { bot_id: string }[]
    return rows.map((r) => r.bot_id)
  }

  private lastMessage(conversationId: string): Message | null {
    const row = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1')
      .get(conversationId) as MessageRow | undefined
    return row ? toMessage(row) : null
  }

  private unreadCount(conversationId: string, lastReadSeq: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages
         WHERE conversation_id = ? AND seq > ? AND author_type != 'user'`,
      )
      .get(conversationId, lastReadSeq) as { n: number }
    return row.n
  }

  private toSummary(row: ConversationRow): ConversationSummary {
    const unread = this.unreadCount(row.id, row.last_read_seq ?? 0)
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      settings: parseJson<Partial<GroupSettings>>(row.settings, {}),
      projectId: row.project_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastMessageAt: row.last_message_at,
      memberBotIds: this.memberBotIds(row.id),
      lastMessage: this.lastMessage(row.id),
      sidebar: {
        sectionId: row.section_id,
        order: row.position ?? 0,
        pinned: row.pinned === 1,
        hidden: row.hidden === 1,
        unreadCount: row.marked_unread === 1 ? Math.max(unread, 1) : unread,
      },
    }
  }

  list(): ConversationSummary[] {
    const rows = this.db
      .prepare(`${CONVERSATION_SELECT} ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id`)
      .all() as ConversationRow[]
    return rows.map((row) => this.toSummary(row))
  }

  get(id: string): ConversationSummary {
    const row = this.db.prepare(`${CONVERSATION_SELECT} AND c.id = ?`).get(id) as ConversationRow | undefined
    if (!row) throw notFound('conversation', id)
    return this.toSummary(row)
  }

  findDirect(botId: string): ConversationSummary | null {
    const row = this.db
      .prepare(
        `SELECT c.id FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id
         WHERE c.type = 'direct' AND c.deleted_at IS NULL AND m.bot_id = ? LIMIT 1`,
      )
      .get(botId) as { id: string } | undefined
    return row ? this.get(row.id) : null
  }

  /** Where a card from `bot` goes: the conversation it is working in, else its direct chat with the user. */
  forCard(bot: Bot, conversationId: string | null): string {
    if (conversationId) {
      const conversation = this.get(conversationId)
      if (conversation.type !== 'internal' && conversation.memberBotIds.includes(bot.id))
        return conversation.id
    }
    const dm = this.findDirect(bot.id)
    if (!dm) throw new DaemonError('not_found', 'No conversation to ask the user in')
    return dm.id
  }

  rename(id: string, title: string | null): void {
    this.db
      .prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, this.now(), id)
  }

  softDelete(id: string): void {
    const now = this.now()
    this.db.prepare('UPDATE conversations SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, id)
  }

  create(input: NewConversation): ConversationSummary {
    const botIds = [...new Set(input.botIds)]
    for (const botId of botIds) this.bots.get(botId)
    if (input.type === 'direct') {
      if (botIds.length !== 1)
        throw new DaemonError('validation_failed', 'A direct conversation has exactly one bot')
      const existing = this.findDirect(botIds[0] as string)
      if (existing) return existing
    }
    if (input.type === 'internal' && botIds.length !== 2) {
      throw new DaemonError('validation_failed', 'An internal conversation has exactly two bots')
    }
    if (input.type === 'session' && botIds.length !== 1) {
      throw new DaemonError('validation_failed', 'A work session has exactly one bot')
    }
    const now = this.now()
    const id = newId('conversation')
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO conversations (id, type, title, settings, project_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.type,
          input.title ?? null,
          JSON.stringify(input.settings ?? {}),
          input.projectId ?? null,
          now,
          now,
        )
      const addMember = this.db.prepare(
        `INSERT INTO conversation_members (conversation_id, member_type, bot_id, joined_at) VALUES (?, ?, ?, ?)`,
      )
      if (input.type !== 'internal') addMember.run(id, 'user', null, now)
      for (const botId of botIds) addMember.run(id, 'bot', botId, now)
      // Internal conversations and work sessions are opened from their cards, never from the sidebar.
      if (input.type !== 'internal' && input.type !== 'session') {
        const { next } = this.db
          .prepare(
            'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM sidebar_items WHERE section_id IS NULL',
          )
          .get() as { next: number }
        this.db
          .prepare('INSERT INTO sidebar_items (conversation_id, section_id, position) VALUES (?, NULL, ?)')
          .run(id, next)
      }
    })()
    return this.get(id)
  }

  /** Internal (bot↔bot, read-only for the user) conversation of a pair of bots, created on first use. */
  internal(botA: string, botB: string): { conversation: ConversationSummary; created: boolean } {
    const row = this.db
      .prepare(
        `SELECT c.id FROM conversations c
         JOIN conversation_members a ON a.conversation_id = c.id AND a.bot_id = ?
         JOIN conversation_members b ON b.conversation_id = c.id AND b.bot_id = ?
         WHERE c.type = 'internal' AND c.deleted_at IS NULL LIMIT 1`,
      )
      .get(botA, botB) as { id: string } | undefined
    if (row) return { conversation: this.get(row.id), created: false }
    return { conversation: this.create({ type: 'internal', botIds: [botA, botB] }), created: true }
  }

  /**
   * A deleted bot leaves every conversation; its direct chat and work sessions are deleted with it (returned).
   */
  removeBot(botId: string, at: number): string[] {
    this.db
      .prepare('UPDATE conversation_members SET left_at = ? WHERE bot_id = ? AND left_at IS NULL')
      .run(at, botId)
    const own = this.db
      .prepare(
        `SELECT c.id FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id
         WHERE c.type IN ('direct', 'session') AND m.bot_id = ? AND c.deleted_at IS NULL`,
      )
      .all(botId) as { id: string }[]
    const markDeleted = this.db.prepare(
      'UPDATE conversations SET deleted_at = ?, updated_at = ? WHERE id = ?',
    )
    for (const row of own) markDeleted.run(at, at, row.id)
    return own.map((r) => r.id)
  }

  private requireGroup(conversationId: string): ConversationSummary {
    const conversation = this.get(conversationId)
    if (conversation.type !== 'group')
      throw new DaemonError('validation_failed', 'Only groups have editable members and settings')
    return conversation
  }

  /** Returns false when the bot already was a member. */
  addMember(conversationId: string, botId: string): boolean {
    const conversation = this.requireGroup(conversationId)
    this.bots.get(botId)
    if (conversation.memberBotIds.includes(botId)) return false
    const now = this.now()
    this.db.transaction(() => {
      const rejoined = this.db
        .prepare(
          'UPDATE conversation_members SET left_at = NULL, joined_at = ? WHERE conversation_id = ? AND bot_id = ?',
        )
        .run(now, conversationId, botId)
      if (rejoined.changes === 0) {
        this.db
          .prepare(
            `INSERT INTO conversation_members (conversation_id, member_type, bot_id, joined_at) VALUES (?, 'bot', ?, ?)`,
          )
          .run(conversationId, botId, now)
      }
      this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId)
    })()
    return true
  }

  /** Returns false when the bot was not a member. A group keeps at least one bot. */
  removeMember(conversationId: string, botId: string): boolean {
    const conversation = this.requireGroup(conversationId)
    if (!conversation.memberBotIds.includes(botId)) return false
    if (conversation.memberBotIds.length <= 1)
      throw new DaemonError('conflict', 'A group needs at least one bot; delete the group instead')
    const now = this.now()
    this.db
      .prepare(
        'UPDATE conversation_members SET left_at = ? WHERE conversation_id = ? AND bot_id = ? AND left_at IS NULL',
      )
      .run(now, conversationId, botId)
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId)
    return true
  }

  updateGroupSettings(conversationId: string, patch: Partial<GroupSettings>): ConversationSummary {
    const conversation = this.requireGroup(conversationId)
    const settings = { ...conversation.settings }
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) (settings as Record<string, unknown>)[key] = value
    }
    this.db
      .prepare('UPDATE conversations SET settings = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(settings), this.now(), conversationId)
    return this.get(conversationId)
  }

  /** Current project of the conversation (null = none); the project must exist. */
  setProject(conversationId: string, projectId: string | null): ConversationSummary {
    this.get(conversationId)
    this.db
      .prepare('UPDATE conversations SET project_id = ?, updated_at = ? WHERE id = ?')
      .run(projectId, this.now(), conversationId)
    return this.get(conversationId)
  }

  setPinned(conversationId: string, pinned: boolean): void {
    this.db
      .prepare('UPDATE sidebar_items SET pinned = ? WHERE conversation_id = ?')
      .run(bool(pinned), conversationId)
  }

  markRead(conversationId: string, lastReadMessageId?: string): void {
    this.get(conversationId)
    const seq = lastReadMessageId
      ? (
          this.db
            .prepare('SELECT seq FROM messages WHERE id = ? AND conversation_id = ?')
            .get(lastReadMessageId, conversationId) as { seq: number } | undefined
        )?.seq
      : (
          this.db
            .prepare('SELECT MAX(seq) AS seq FROM messages WHERE conversation_id = ?')
            .get(conversationId) as {
            seq: number | null
          }
        ).seq
    this.db
      .prepare(
        `UPDATE sidebar_items SET last_read_seq = MAX(last_read_seq, ?), marked_unread = 0
         WHERE conversation_id = ?`,
      )
      .run(seq ?? 0, conversationId)
  }
}
