import { posix } from 'node:path'

import type {
  Attachment,
  AttachmentImage,
  AttachmentStatus,
  ChatFile,
  ListFilesQuery,
  MessageAttachment,
} from '@milibot/shared'
import type { z } from 'zod'

import type { Db } from '../../db/sqlite'
import { notFound } from '../../errors'

export interface AttachmentRow {
  id: string
  conversation_id: string
  message_id: string | null
  name: string
  size: number
  mime_type: string
  vm_path: string
  status: AttachmentStatus
  received: number
  image: string | null
  error: string | null
  created_at: number
  updated_at: number
}

/** A row that starts in the VM already (`ready`): shared files and mentioned images. */
export interface ReadyAttachment {
  id: string
  conversationId: string
  messageId: string | null
  name: string
  size: number
  mimeType: string
  path: string
  image: AttachmentImage | null
}

export function toAttachment(row: AttachmentRow, progress?: number): Attachment {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    name: posix.basename(row.vm_path),
    size: row.size,
    mimeType: row.mime_type,
    path: row.vm_path,
    status: row.status,
    progress: progress ?? (row.status === 'ready' ? 1 : 0),
    image: row.image ? (JSON.parse(row.image) as AttachmentImage) : null,
    error: row.error,
    createdAt: row.created_at,
  }
}

export function toMessageAttachment(row: AttachmentRow): MessageAttachment {
  const { id, name, size, mimeType, path, status, image } = toAttachment(row)
  return { id, name, size, mimeType, path, status, image }
}

/** The `attachments` rows: every file of the chats, from upload to removal. */
export class AttachmentStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  find(id: string): AttachmentRow | undefined {
    return this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as AttachmentRow | undefined
  }

  row(id: string): AttachmentRow {
    const row = this.find(id)
    if (!row) throw notFound('attachment', id)
    return row
  }

  /** Whether another live row already uses `path` in the VM. */
  pathTaken(path: string, exceptId?: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM attachments WHERE vm_path = ? AND status NOT IN ('failed', 'removed') AND id != ?",
        )
        .get(path, exceptId ?? ''),
    )
  }

  /** Copies interrupted by a restart go back to the queue; returns uploads abandoned before `before`. */
  recover(before: number): string[] {
    this.db.prepare("UPDATE attachments SET status = 'queued' WHERE status = 'copying'").run()
    return (
      this.db
        .prepare("SELECT id FROM attachments WHERE status = 'uploading' AND updated_at < ?")
        .all(before) as Array<{ id: string }>
    ).map((r) => r.id)
  }

  insertUpload(input: {
    id: string
    conversationId: string
    name: string
    size: number
    mimeType: string
    path: string
  }): void {
    const now = this.now()
    this.db
      .prepare(
        `INSERT INTO attachments (id, conversation_id, name, size, mime_type, vm_path, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'uploading', ?, ?)`,
      )
      .run(input.id, input.conversationId, input.name, input.size, input.mimeType, input.path, now, now)
  }

  insertReady(input: ReadyAttachment): void {
    const now = this.now()
    this.db
      .prepare(
        `INSERT INTO attachments (id, conversation_id, message_id, name, size, mime_type, vm_path, status, received, image, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.conversationId,
        input.messageId,
        input.name,
        input.size,
        input.mimeType,
        input.path,
        input.size,
        input.image ? JSON.stringify(input.image) : null,
        now,
        now,
      )
  }

  setReceived(id: string, received: number): void {
    this.db
      .prepare('UPDATE attachments SET received = ?, updated_at = ? WHERE id = ?')
      .run(received, this.now(), id)
  }

  /** The upload finished: queued for the VM, with its model image when it has one. */
  queue(id: string, image: AttachmentImage | null, mimeType: string): void {
    this.db
      .prepare(
        "UPDATE attachments SET status = 'queued', image = ?, mime_type = ?, updated_at = ? WHERE id = ?",
      )
      .run(image ? JSON.stringify(image) : null, mimeType, this.now(), id)
  }

  nextQueued(): AttachmentRow | undefined {
    return this.db
      .prepare("SELECT * FROM attachments WHERE status = 'queued' ORDER BY created_at LIMIT 1")
      .get() as AttachmentRow | undefined
  }

  setStatus(
    id: string,
    status: AttachmentStatus,
    extra: { error?: string | null; vmPath?: string } = {},
  ): void {
    this.db
      .prepare(
        'UPDATE attachments SET status = ?, error = ?, vm_path = COALESCE(?, vm_path), updated_at = ? WHERE id = ?',
      )
      .run(status, extra.error ?? null, extra.vmPath ?? null, this.now(), id)
  }

  rename(id: string, name: string, path: string): void {
    this.db
      .prepare('UPDATE attachments SET name = ?, vm_path = ?, updated_at = ? WHERE id = ?')
      .run(name, path, this.now(), id)
  }

  bind(ids: string[], messageId: string): void {
    const update = this.db.prepare('UPDATE attachments SET message_id = ? WHERE id = ?')
    for (const id of ids) update.run(messageId, id)
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM attachments WHERE id = ?').run(id)
  }

  /** Images of attachments: the conversation keeps sending them to the models. */
  referencedBlobs(): string[] {
    return (
      this.db
        .prepare("SELECT json_extract(image, '$.sha256') AS sha FROM attachments WHERE image IS NOT NULL")
        .all() as Array<{ sha: string | null }>
    ).flatMap((r) => r.sha ?? [])
  }

  /** Files sent in the chats that are still in the VM (or on their way), newest first. */
  listFiles(query: z.output<typeof ListFilesQuery>): {
    files: ChatFile[]
    hasMore: boolean
    totals: Array<{ author: string; n: number; bytes: number }>
  } {
    const base = ["a.status NOT IN ('uploading', 'removed')", 'c.deleted_at IS NULL']
    const baseParams: Array<string | number> = []
    if (query.query) {
      base.push("a.name LIKE ? ESCAPE '\\'")
      baseParams.push(`%${query.query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    }
    const from = `FROM attachments a
         JOIN messages m ON m.id = a.message_id
         JOIN conversations c ON c.id = a.conversation_id`
    const totals = this.db
      .prepare(
        `SELECT m.author_type AS author, COUNT(*) AS n, COALESCE(SUM(a.size), 0) AS bytes
         ${from} WHERE ${base.join(' AND ')} GROUP BY m.author_type`,
      )
      .all(...baseParams) as Array<{ author: string; n: number; bytes: number }>

    const where = [...base]
    const params = [...baseParams]
    if (query.source) {
      where.push('m.author_type = ?')
      params.push(query.source === 'bots' ? 'bot' : 'user')
    }
    if (query.before) {
      const cursor = this.row(query.before)
      where.push('(a.created_at < ? OR (a.created_at = ? AND a.id < ?))')
      params.push(cursor.created_at, cursor.created_at, cursor.id)
    }
    const rows = this.db
      .prepare(
        `SELECT a.*, m.author_type, m.author_bot_id ${from}
         WHERE ${where.join(' AND ')}
         ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
      )
      .all(...params, query.limit + 1) as Array<
      AttachmentRow & { author_type: 'user' | 'bot'; author_bot_id: string | null }
    >
    const files = rows.slice(0, query.limit).map((row): ChatFile => ({
      attachment: toMessageAttachment(row),
      conversationId: row.conversation_id,
      messageId: row.message_id as string,
      authorType: row.author_type,
      authorBotId: row.author_bot_id,
      createdAt: row.created_at,
    }))
    return { files, hasMore: rows.length > query.limit, totals }
  }
}
