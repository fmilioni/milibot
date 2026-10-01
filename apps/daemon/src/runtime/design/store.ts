import {
  type Design,
  DESIGN_LIMITS,
  type DesignArtStatus,
  type DesignFrame,
  type DesignRevision,
  type DesignToken,
  newId,
  type PlacedFrame,
} from '@milibot/shared'

import type { Db } from '../../db/sqlite'
import { parseJson } from '../../db/sqlite'

export interface DesignRow {
  id: string
  name: string
  conversation_id: string | null
  bot_id: string | null
  themes_json: string
  tokens_json: string
  fonts_json: string
  message_id: string | null
  thumbnail_sha: string | null
  archived_at: number | null
  created_at: number
  updated_at: number
}

export interface FrameRow {
  id: string
  design_id: string
  name: string
  x: number
  y: number
  width: number
  height: number | null
  measured_height: number | null
  theme: string | null
  html: string
  css: string
  position: number
  updated_at: number
  art_status?: DesignArtStatus | null
  art_json?: string | null
}

export interface ArtInfo {
  prompt: string
  botId: string | null
  error: string | null
  startedAt: number
  finishedAt: number | null
}

export function artInfo(row: FrameRow): ArtInfo | null {
  return row.art_status ? parseJson<ArtInfo | null>(row.art_json ?? null, null) : null
}

interface RevisionRow {
  id: string
  design_id: string
  frame_id: string | null
  author_type: 'bot' | 'user'
  author_bot_id: string | null
  turn_id: string | null
  summary: string
  snapshot_json: string
  created_at: number
}

/** Themes, tokens and fonts of a design: what a token revision captures. */
export interface DesignLook {
  name: string
  themes: string[]
  tokens: DesignToken[]
  fonts: string[]
}

export type RevisionSnapshot =
  | { kind: 'frame'; before: FrameRow | null; after: FrameRow | null }
  | { kind: 'look'; before: DesignLook; after: DesignLook }

export interface RevisionAuthor {
  type: 'bot' | 'user'
  botId: string | null
  turnId: string | null
}

export function toFrame(row: FrameRow): DesignFrame {
  return {
    id: row.id,
    designId: row.design_id,
    name: row.name,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    measuredHeight: row.measured_height,
    theme: row.theme,
    position: row.position,
    updatedAt: row.updated_at,
    ...(row.art_status ? { art: { status: row.art_status, botId: artInfo(row)?.botId ?? null } } : {}),
  }
}

/** Height assumed for placing a frame that grows with its content and was never rendered. */
export const AUTO_HEIGHT_GUESS = 900

export function placedFrames(rows: readonly FrameRow[]): PlacedFrame[] {
  return rows.map((f) => ({
    id: f.id,
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height ?? f.measured_height ?? AUTO_HEIGHT_GUESS,
  }))
}

export function lookOf(row: DesignRow): DesignLook {
  return {
    name: row.name,
    themes: parseJson<string[]>(row.themes_json, []),
    tokens: parseJson<DesignToken[]>(row.tokens_json, []),
    fonts: parseJson<string[]>(row.fonts_json, []),
  }
}

/** Rows of `designs`, `design_frames` and `design_revisions`. */
export class DesignStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  row(id: string): DesignRow | null {
    return (this.db.prepare('SELECT * FROM designs WHERE id = ?').get(id) as DesignRow | undefined) ?? null
  }

  rows(filter: { conversationId?: string; botId?: string; archived?: boolean } = {}): DesignRow[] {
    const where: string[] = filter.archived ? [] : ['archived_at IS NULL']
    const args: unknown[] = []
    if (filter.conversationId) {
      where.push('conversation_id = ?')
      args.push(filter.conversationId)
    }
    if (filter.botId) {
      where.push('bot_id = ?')
      args.push(filter.botId)
    }
    return this.db
      .prepare(
        `SELECT * FROM designs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC, id DESC`,
      )
      .all(...args) as DesignRow[]
  }

  toDesign(row: DesignRow): Design {
    const look = lookOf(row)
    const { count } = this.db
      .prepare('SELECT COUNT(*) AS count FROM design_frames WHERE design_id = ?')
      .get(row.id) as { count: number }
    return {
      id: row.id,
      name: row.name,
      conversationId: row.conversation_id,
      botId: row.bot_id,
      themes: look.themes,
      tokens: look.tokens,
      fonts: look.fonts,
      frameCount: count,
      thumbnailSha: row.thumbnail_sha,
      archivedAt: row.archived_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  insert(input: {
    name: string
    conversationId: string | null
    botId: string | null
    look: Omit<DesignLook, 'name'>
  }): DesignRow {
    const id = newId('design')
    const now = this.now()
    this.db
      .prepare(
        `INSERT INTO designs (id, name, conversation_id, bot_id, themes_json, tokens_json, fonts_json, created_at,
          updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.conversationId,
        input.botId,
        JSON.stringify(input.look.themes),
        JSON.stringify(input.look.tokens),
        JSON.stringify(input.look.fonts),
        now,
        now,
      )
    return this.row(id) as DesignRow
  }

  update(id: string, patch: Partial<Omit<DesignRow, 'id' | 'created_at'>>): DesignRow {
    const entries = Object.entries({ ...patch, updated_at: patch.updated_at ?? this.now() })
    this.db
      .prepare(`UPDATE designs SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...entries.map(([, v]) => v), id)
    return this.row(id) as DesignRow
  }

  setLook(id: string, look: DesignLook): DesignRow {
    return this.update(id, {
      name: look.name,
      themes_json: JSON.stringify(look.themes),
      tokens_json: JSON.stringify(look.tokens),
      fonts_json: JSON.stringify(look.fonts),
    })
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM designs WHERE id = ?').run(id)
  }

  frames(designId: string): FrameRow[] {
    return this.db
      .prepare('SELECT * FROM design_frames WHERE design_id = ? ORDER BY position, id')
      .all(designId) as FrameRow[]
  }

  frame(id: string): FrameRow | null {
    return (
      (this.db.prepare('SELECT * FROM design_frames WHERE id = ?').get(id) as FrameRow | undefined) ?? null
    )
  }

  /** Writes a frame row as given (insert or replace), keeping positions contiguous. */
  putFrame(row: FrameRow): FrameRow {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO design_frames (id, design_id, name, x, y, width, height, measured_height, theme,
          html, css, position, updated_at, art_status, art_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.design_id,
        row.name,
        row.x,
        row.y,
        row.width,
        row.height,
        row.measured_height,
        row.theme,
        row.html,
        row.css,
        row.position,
        row.updated_at,
        row.art_status ?? null,
        row.art_status ? (row.art_json ?? null) : null,
      )
    return this.frame(row.id) as FrameRow
  }

  deleteFrame(id: string): void {
    const row = this.frame(id)
    if (!row) return
    this.db.prepare('DELETE FROM design_frames WHERE id = ?').run(id)
    this.renumber(row.design_id)
  }

  /** Moves a frame to `position` (0-based) in the design's order. */
  reorder(designId: string, frameId: string, position: number): void {
    const ids = this.frames(designId).map((f) => f.id)
    const from = ids.indexOf(frameId)
    if (from < 0) return
    ids.splice(from, 1)
    ids.splice(Math.max(0, Math.min(position, ids.length)), 0, frameId)
    const update = this.db.prepare('UPDATE design_frames SET position = ? WHERE id = ?')
    this.db.transaction(() => ids.forEach((id, i) => update.run(i, id)))()
  }

  renumber(designId: string): void {
    const update = this.db.prepare('UPDATE design_frames SET position = ? WHERE id = ?')
    const ids = this.frames(designId).map((f) => f.id)
    this.db.transaction(() => ids.forEach((id, i) => update.run(i, id)))()
  }

  failInterruptedArt(): void {
    this.db
      .prepare(
        `UPDATE design_frames SET art_status = 'failed', art_json = json_set(COALESCE(art_json, '{}'), '$.error', 'interrupted')
         WHERE art_status = 'drawing'`,
      )
      .run()
  }

  setMeasuredHeight(frameId: string, height: number): void {
    this.db.prepare('UPDATE design_frames SET measured_height = ? WHERE id = ?').run(height, frameId)
  }

  addRevision(
    designId: string,
    frameId: string | null,
    author: RevisionAuthor,
    summary: string,
    snapshot: RevisionSnapshot,
  ): string {
    const id = newId('designRevision')
    this.db
      .prepare(
        `INSERT INTO design_revisions (id, design_id, frame_id, author_type, author_bot_id, turn_id, summary,
          snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        designId,
        frameId,
        author.type,
        author.botId,
        author.turnId,
        summary,
        JSON.stringify(snapshot),
        this.now(),
      )
    this.db
      .prepare(
        `DELETE FROM design_revisions WHERE design_id = ? AND id NOT IN (
           SELECT id FROM design_revisions WHERE design_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)`,
      )
      .run(designId, designId, DESIGN_LIMITS.revisions)
    return id
  }

  /** For a change the daemon makes right after saving the frame. */
  amendFrameRevision(designId: string, after: FrameRow): void {
    const row = this.db
      .prepare(
        'SELECT id, snapshot_json FROM design_revisions WHERE design_id = ? AND frame_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      )
      .get(designId, after.id) as { id: string; snapshot_json: string } | undefined
    if (!row) return
    const snapshot = JSON.parse(row.snapshot_json) as RevisionSnapshot
    if (snapshot.kind !== 'frame') return
    this.db
      .prepare('UPDATE design_revisions SET snapshot_json = ? WHERE id = ?')
      .run(JSON.stringify({ ...snapshot, after }), row.id)
  }

  revisions(designId: string): DesignRevision[] {
    return (
      this.db
        .prepare('SELECT * FROM design_revisions WHERE design_id = ? ORDER BY created_at DESC, id DESC')
        .all(designId) as RevisionRow[]
    ).map((r) => ({
      id: r.id,
      designId: r.design_id,
      frameId: r.frame_id,
      authorType: r.author_type,
      authorBotId: r.author_bot_id,
      turnId: r.turn_id,
      summary: r.summary,
      createdAt: r.created_at,
    }))
  }

  revision(
    designId: string,
    id: string,
  ): { frameId: string | null; summary: string; snapshot: RevisionSnapshot } | null {
    const row = this.db
      .prepare('SELECT * FROM design_revisions WHERE design_id = ? AND id = ?')
      .get(designId, id) as RevisionRow | undefined
    if (!row) return null
    return {
      frameId: row.frame_id,
      summary: row.summary,
      snapshot: JSON.parse(row.snapshot_json) as RevisionSnapshot,
    }
  }

  /** Designs a board card can link to, newest first. */
  linkTargets(): Array<{ id: string; title: string }> {
    return this.db.prepare('SELECT id, name AS title FROM designs ORDER BY updated_at DESC').all() as Array<{
      id: string
      title: string
    }>
  }

  /** Blob shas designs still use (images, thumbnails), for the debug retention. */
  referencedBlobs(): Set<string> {
    const shas = new Set<string>()
    const scan = (text: string | null) => {
      if (text) for (const m of text.matchAll(/asset:([0-9a-f]{64})/g)) shas.add(m[1] as string)
    }
    for (const row of this.db.prepare('SELECT html, css FROM design_frames').all() as Array<{
      html: string
      css: string
    }>) {
      scan(row.html)
      scan(row.css)
    }
    for (const row of this.db.prepare('SELECT snapshot_json FROM design_revisions').all() as Array<{
      snapshot_json: string
    }>)
      scan(row.snapshot_json)
    for (const row of this.db
      .prepare('SELECT thumbnail_sha FROM designs WHERE thumbnail_sha IS NOT NULL')
      .all() as Array<{ thumbnail_sha: string }>)
      shas.add(row.thumbnail_sha)
    return shas
  }
}
