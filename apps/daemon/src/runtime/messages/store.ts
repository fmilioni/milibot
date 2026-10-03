import { type AuthorType, type Message, type MessageKind, type MessagePayload, newId } from '@milibot/shared'

import { type Db, parseJson } from '../../db/sqlite'
import { DaemonError, notFound } from '../../errors'
import type { ConversationStore } from '../conversations/store'

export interface MessageRow {
  seq: number
  id: string
  conversation_id: string
  author_type: AuthorType
  author_bot_id: string | null
  kind: MessageKind
  content: string
  payload: string | null
  created_at: number
}

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    authorType: row.author_type,
    authorBotId: row.author_bot_id,
    kind: row.kind,
    content: row.content,
    payload: parseJson<MessagePayload | null>(row.payload, null),
    createdAt: row.created_at,
  }
}

export interface NewMessage {
  conversationId: string
  authorType: AuthorType
  authorBotId?: string | null
  kind?: MessageKind
  content: string
  payload?: MessagePayload | null
  turnId?: string | null
}

/** The `messages` table (its FTS index follows through triggers). */
export class MessageStore {
  constructor(
    private readonly db: Db,
    private readonly conversations: ConversationStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** Pictures of `generated_images` cards (they stay in their chat card). */
  generatedImageBlobs(): string[] {
    return (
      this.db
        .prepare(
          `SELECT json_extract(image.value, '$.sha') AS sha FROM messages, json_each(messages.payload, '$.images') AS image
           WHERE json_extract(messages.payload, '$.type') = 'generated_images'`,
        )
        .all() as Array<{ sha: string | null }>
    ).flatMap((r) => r.sha ?? [])
  }

  list(
    conversationId: string,
    options: { before?: string; limit: number },
  ): { messages: Message[]; hasMore: boolean } {
    this.conversations.get(conversationId)
    let beforeSeq = Number.MAX_SAFE_INTEGER
    if (options.before) {
      const row = this.db
        .prepare('SELECT seq FROM messages WHERE id = ? AND conversation_id = ?')
        .get(options.before, conversationId) as { seq: number } | undefined
      if (!row) throw notFound('message', options.before)
      beforeSeq = row.seq
    }
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
      .all(conversationId, beforeSeq, options.limit + 1) as MessageRow[]
    const hasMore = rows.length > options.limit
    return { messages: rows.slice(0, options.limit).reverse().map(toMessage), hasMore }
  }

  create(input: NewMessage): Message {
    const conversation = this.conversations.get(input.conversationId)
    if (input.authorType === 'bot') {
      if (!input.authorBotId || !conversation.memberBotIds.includes(input.authorBotId)) {
        throw new DaemonError('validation_failed', 'Bot author must be a member of the conversation')
      }
    }
    const now = this.now()
    const id = newId('message')
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO messages (id, conversation_id, author_type, author_bot_id, kind, content, payload, turn_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.conversationId,
          input.authorType,
          input.authorType === 'bot' ? (input.authorBotId ?? null) : null,
          input.kind ?? 'text',
          input.content,
          input.payload ? JSON.stringify(input.payload) : null,
          input.turnId ?? null,
          now,
        )
      this.db
        .prepare('UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE id = ?')
        .run(now, now, input.conversationId)
      if (input.authorType === 'user') {
        this.db
          .prepare(
            `UPDATE sidebar_items SET last_read_seq = (SELECT seq FROM messages WHERE id = ?), marked_unread = 0
             WHERE conversation_id = ?`,
          )
          .run(id, input.conversationId)
      }
    })()
    return this.get(id)
  }

  get(id: string): Message {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined
    if (!row) throw notFound('message', id)
    return toMessage(row)
  }

  /** The stored payload of a message as JSON (null: no message or no payload), without validating it. */
  payload(id: string): unknown {
    const row = this.db.prepare('SELECT payload FROM messages WHERE id = ?').get(id) as
      { payload: string | null } | undefined
    return parseJson<unknown>(row?.payload, null)
  }

  /** The first card of a conversation whose payload has `type`, with its raw payload. */
  firstCard(conversationId: string, type: string): { id: string; payload: unknown } | null {
    const row = this.db
      .prepare(
        `SELECT id, payload FROM messages WHERE conversation_id = ? AND kind = 'card'
         AND json_extract(payload, '$.type') = ? ORDER BY seq LIMIT 1`,
      )
      .get(conversationId, type) as { id: string; payload: string } | undefined
    return row ? { id: row.id, payload: parseJson<unknown>(row.payload, null) } : null
  }

  /**
   * The newest card of any conversation whose payload has `type` and the given field values (`fields` keys are
   * payload properties named by code, never by input).
   */
  latestCard(type: string, fields: Record<string, string | number>): { id: string; payload: unknown } | null {
    return this.cardsWith(type, fields, 1)[0] ?? null
  }

  /** Cards whose payload has `type` and the given field values, newest first (see `latestCard`). */
  cardsWith(
    type: string,
    fields: Record<string, string | number>,
    limit = 1000,
  ): Array<{ id: string; payload: unknown }> {
    const keys = Object.keys(fields)
    if (keys.some((key) => !/^\w+$/.test(key))) throw new Error('invalid payload field')
    const rows = this.db
      .prepare(
        `SELECT id, payload FROM messages WHERE kind = 'card' AND json_extract(payload, '$.type') = ?
         ${keys.map((key) => `AND json_extract(payload, '$.${key}') = ?`).join(' ')}
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(type, ...keys.map((key) => fields[key]), limit) as Array<{ id: string; payload: string }>
    return rows.map((row) => ({ id: row.id, payload: parseJson<unknown>(row.payload, null) }))
  }

  update(id: string, patch: { content?: string; payload?: MessagePayload | null }): void {
    const row = this.db.prepare('SELECT content, payload FROM messages WHERE id = ?').get(id) as
      { content: string; payload: string | null } | undefined
    if (!row) throw notFound('message', id)
    const payload =
      patch.payload === undefined
        ? row.payload
        : patch.payload === null
          ? null
          : JSON.stringify(patch.payload)
    this.db
      .prepare('UPDATE messages SET content = ?, payload = ? WHERE id = ?')
      .run(patch.content ?? row.content, payload, id)
  }

  /** `system_event` messages of `event` whose `payload.params[param]` is `value`. */
  systemEvents(event: string, param: string, value: string): Array<{ id: string; conversationId: string }> {
    if (!/^\w+$/.test(param)) throw new Error(`invalid param name: ${param}`)
    return (
      this.db
        .prepare(
          `SELECT id, conversation_id FROM messages
           WHERE kind = 'system_event' AND json_extract(payload, '$.event') = ?
             AND json_extract(payload, '$.params.${param}') = ?`,
        )
        .all(event, value) as Array<{ id: string; conversation_id: string }>
    ).map((r) => ({ id: r.id, conversationId: r.conversation_id }))
  }

  /** Deletes a message; returns its conversation, or null if it was already gone. */
  delete(id: string): string | null {
    const row = this.db.prepare('SELECT conversation_id FROM messages WHERE id = ?').get(id) as
      { conversation_id: string } | undefined
    if (!row) return null
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id)
    return row.conversation_id
  }

  search(query: string, limit = 20): Message[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages_fts f JOIN messages m ON m.seq = f.rowid
         WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(query, limit) as MessageRow[]
    return rows.map(toMessage)
  }
}
