import {
  type Avatar,
  type Bot,
  type BotStatus,
  findBotByRef,
  FIRST_BOT_UID,
  newId,
  randomAvatar,
  type ReasoningEffort,
  slugify,
  VNC_DISPLAYS,
} from '@milibot/shared'

import type { Db } from '../../db/sqlite'
import { DaemonError, notFound } from '../../errors'

const FIRST_DISPLAY = 1

interface BotRow {
  id: string
  name: string
  slug: string
  label: string
  system_prompt: string
  provider_id: string | null
  model: string | null
  effort: ReasoningEffort | null
  context_limit: number | null
  max_output_tokens: number | null
  avatar_shape: Avatar['shape']
  avatar_color: Avatar['color']
  avatar_eyes: Avatar['eyes']
  linux_uid: number
  display_num: number
  status: BotStatus
  created_at: number
  updated_at: number
}

function toBot(row: BotRow): Bot {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    label: row.label,
    systemPrompt: row.system_prompt,
    providerId: row.provider_id,
    model: row.model,
    effort: row.effort,
    contextLimit: row.context_limit,
    maxOutputTokens: row.max_output_tokens,
    avatar: { shape: row.avatar_shape, color: row.avatar_color, eyes: row.avatar_eyes },
    linuxUid: row.linux_uid,
    displayNum: row.display_num,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Slugs name the bot's Linux user (`bot-<slug>`), so they must start with a letter (guest rule). */
export function botSlug(name: string): string {
  const base = slugify(name, { maxLength: 24 })
  if (!base) return 'bot'
  return /^[a-z]/.test(base) ? base : slugify(`b-${base}`, { maxLength: 24 })
}

export interface NewBot {
  name: string
  label?: string
  systemPrompt?: string
  providerId?: string | null
  model?: string | null
  effort?: ReasoningEffort | null
  contextLimit?: number | null
  maxOutputTokens?: number | null
  avatar?: Avatar
}

/** The `bots` table. */
export class BotStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  list(): Bot[] {
    const rows = this.db
      .prepare('SELECT * FROM bots WHERE deleted_at IS NULL ORDER BY created_at, id')
      .all() as BotRow[]
    return rows.map(toBot)
  }

  find(id: string): Bot | null {
    const row = this.db.prepare('SELECT * FROM bots WHERE id = ? AND deleted_at IS NULL').get(id) as
      BotRow | undefined
    return row ? toBot(row) : null
  }

  /** The bot a model or a person names (see `findBotByRef`). */
  resolveRef(ref: string): Bot | null {
    return findBotByRef(this.list(), ref)
  }

  get(id: string): Bot {
    const bot = this.find(id)
    if (!bot) throw notFound('bot', id)
    return bot
  }

  /** The oldest active bot (see `firstBot` in shared). */
  first(): Bot | null {
    const row = this.db
      .prepare('SELECT * FROM bots WHERE deleted_at IS NULL ORDER BY created_at, id LIMIT 1')
      .get() as BotRow | undefined
    return row ? toBot(row) : null
  }

  /** A workspace always keeps one bot. */
  assertDeletable(id: string): Bot {
    const bot = this.get(id)
    const { count } = this.db
      .prepare('SELECT COUNT(*) AS count FROM bots WHERE deleted_at IS NULL')
      .get() as {
      count: number
    }
    if (count <= 1)
      throw new DaemonError('conflict', 'The last bot of the workspace cannot be deleted', {
        reason: 'last_bot',
      })
    return bot
  }

  private uniqueSlug(name: string): string {
    const base = botSlug(name)
    const exists = this.db.prepare('SELECT 1 FROM bots WHERE slug = ?')
    let slug = base
    for (let n = 2; exists.get(slug); n++) slug = `${base}-${n}`
    return slug
  }

  create(input: NewBot): Bot {
    const now = this.now()
    const id = newId('bot')
    const avatar = input.avatar ?? randomAvatar()
    const { uid } = this.db.prepare('SELECT MAX(linux_uid) AS uid FROM bots').get() as { uid: number | null }
    const display = this.freeDisplay()
    this.db
      .prepare(
        `INSERT INTO bots (id, name, slug, label, system_prompt, provider_id, model, effort, context_limit,
           max_output_tokens, avatar_shape, avatar_color, avatar_eyes, linux_uid, display_num, status, created_at,
           updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)`,
      )
      .run(
        id,
        input.name,
        this.uniqueSlug(input.name),
        input.label ?? '',
        input.systemPrompt ?? '',
        input.providerId ?? null,
        input.model ?? null,
        input.effort ?? null,
        input.contextLimit ?? null,
        input.maxOutputTokens ?? null,
        avatar.shape,
        avatar.color,
        avatar.eyes,
        uid === null ? FIRST_BOT_UID : uid + 1,
        display,
        now,
        now,
      )
    return this.get(id)
  }

  /**
   * Lowest display not used by a live bot nor by a deleted bot whose desktop may still exist in the
   * VM (released by `markRemovedFromVm`).
   */
  private freeDisplay(): number {
    const used = new Set(
      (
        this.db
          .prepare('SELECT display_num FROM bots WHERE deleted_at IS NULL OR vm_removed_at IS NULL')
          .all() as { display_num: number }[]
      ).map((r) => r.display_num),
    )
    let display = FIRST_DISPLAY
    while (used.has(display)) display++
    if (display > VNC_DISPLAYS)
      throw new DaemonError('conflict', `A workspace can have at most ${VNC_DISPLAYS} bots`)
    return display
  }

  /** Deleted bots whose Linux user/desktop has not been removed from the VM yet. */
  pendingRemovals(): Array<{ id: string; slug: string; displayNum: number }> {
    const rows = this.db
      .prepare(
        'SELECT id, slug, display_num FROM bots WHERE deleted_at IS NOT NULL AND vm_removed_at IS NULL ORDER BY deleted_at',
      )
      .all() as { id: string; slug: string; display_num: number }[]
    return rows.map((r) => ({ id: r.id, slug: r.slug, displayNum: r.display_num }))
  }

  /** The VM no longer has the deleted bot: its display becomes reusable (`display_num` is UNIQUE). */
  markRemovedFromVm(slug: string): void {
    this.db
      .prepare(
        `UPDATE bots SET vm_removed_at = ?, display_num = -rowid
         WHERE slug = ? AND deleted_at IS NOT NULL AND vm_removed_at IS NULL`,
      )
      .run(this.now(), slug)
  }

  update(id: string, patch: Partial<NewBot>): Bot {
    const current = this.get(id)
    const next = {
      name: patch.name ?? current.name,
      label: patch.label ?? current.label,
      systemPrompt: patch.systemPrompt ?? current.systemPrompt,
      providerId: patch.providerId === undefined ? current.providerId : patch.providerId,
      model: patch.model === undefined ? current.model : patch.model,
      effort: patch.effort === undefined ? current.effort : patch.effort,
      contextLimit: patch.contextLimit === undefined ? current.contextLimit : patch.contextLimit,
      maxOutputTokens: patch.maxOutputTokens === undefined ? current.maxOutputTokens : patch.maxOutputTokens,
      avatar: patch.avatar ?? current.avatar,
    }
    this.db
      .prepare(
        `UPDATE bots SET name = ?, label = ?, system_prompt = ?, provider_id = ?, model = ?, effort = ?,
           context_limit = ?, max_output_tokens = ?, avatar_shape = ?, avatar_color = ?, avatar_eyes = ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.name,
        next.label,
        next.systemPrompt,
        next.providerId,
        next.model,
        next.effort,
        next.contextLimit,
        next.maxOutputTokens,
        next.avatar.shape,
        next.avatar.color,
        next.avatar.eyes,
        this.now(),
        id,
      )
    return this.get(id)
  }

  /** `effort` is transient and stored as `working`. */
  setStatus(id: string, status: BotStatus): Bot {
    const result = this.db
      .prepare('UPDATE bots SET status = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(status === 'effort' ? 'working' : status, this.now(), id)
    if (result.changes === 0) throw notFound('bot', id)
    return this.get(id)
  }

  /**
   * Soft delete: messages keep their author and the Linux UID stays reserved; the display stays reserved
   * until the VM confirms the removal of the bot's user and desktop.
   */
  softDelete(id: string, at: number): void {
    this.db.prepare('UPDATE bots SET deleted_at = ?, updated_at = ? WHERE id = ?').run(at, at, id)
  }
}
