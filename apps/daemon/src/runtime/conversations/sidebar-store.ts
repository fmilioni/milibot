import {
  applySidebarMove,
  newId,
  type SidebarOrderItem,
  type SidebarSection,
  type SidebarSlot,
} from '@milibot/shared'

import { bool, type Db } from '../../db/sqlite'
import { notFound } from '../../errors'

interface SectionRow {
  id: string
  name: string
  position: number
  collapsed: number
}

function toSection(row: SectionRow): SidebarSection {
  return { id: row.id, name: row.name, order: row.position, collapsed: row.collapsed === 1 }
}

/** User sections, ordering, pin, hide and unread flags of the sidebar (`sidebar_sections`/`sidebar_items`). */
export class SidebarStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  listSections(): SidebarSection[] {
    const rows = this.db.prepare('SELECT * FROM sidebar_sections ORDER BY position, id').all() as SectionRow[]
    return rows.map(toSection)
  }

  private getSection(id: string): SidebarSection {
    const row = this.db.prepare('SELECT * FROM sidebar_sections WHERE id = ?').get(id) as
      SectionRow | undefined
    if (!row) throw notFound('section', id)
    return toSection(row)
  }

  createSection(name: string): SidebarSection {
    const { next } = this.db
      .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM sidebar_sections')
      .get() as { next: number }
    const id = newId('sidebarSection')
    this.db
      .prepare(
        'INSERT INTO sidebar_sections (id, name, position, collapsed, created_at) VALUES (?, ?, ?, 0, ?)',
      )
      .run(id, name, next, this.now())
    return this.getSection(id)
  }

  updateSection(id: string, patch: { name?: string; collapsed?: boolean }): SidebarSection {
    this.getSection(id)
    if (patch.name !== undefined)
      this.db.prepare('UPDATE sidebar_sections SET name = ? WHERE id = ?').run(patch.name, id)
    if (patch.collapsed !== undefined) {
      this.db.prepare('UPDATE sidebar_sections SET collapsed = ? WHERE id = ?').run(bool(patch.collapsed), id)
    }
    return this.getSection(id)
  }

  /** Returns the conversations that moved to "No section". */
  deleteSection(id: string): string[] {
    this.getSection(id)
    const moved = this.orderItems().filter((item) => item.sectionId === id)
    this.db.transaction(() => {
      for (const item of moved.filter((i) => !i.pinned)) {
        this.move(item.id, { pinned: false, sectionId: null })
      }
      this.db.prepare('UPDATE sidebar_items SET section_id = NULL WHERE section_id = ?').run(id)
      this.db.prepare('DELETE FROM sidebar_sections WHERE id = ?').run(id)
    })()
    return moved.map((item) => item.id)
  }

  reorderSections(sectionIds: string[]): SidebarSection[] {
    const known = this.listSections().map((s) => s.id)
    const ordered = [
      ...sectionIds.filter((id) => known.includes(id)),
      ...known.filter((id) => !sectionIds.includes(id)),
    ]
    const update = this.db.prepare('UPDATE sidebar_sections SET position = ? WHERE id = ?')
    this.db.transaction(() => ordered.forEach((id, position) => update.run(position, id)))()
    return this.listSections()
  }

  orderItems(): SidebarOrderItem[] {
    const rows = this.db
      .prepare(
        `SELECT s.conversation_id AS id, s.section_id, s.position, s.pinned, c.created_at
         FROM sidebar_items s JOIN conversations c ON c.id = s.conversation_id
         WHERE c.deleted_at IS NULL`,
      )
      .all() as {
      id: string
      section_id: string | null
      position: number
      pinned: number
      created_at: number
    }[]
    return rows.map((r) => ({
      id: r.id,
      sectionId: r.section_id,
      order: r.position,
      pinned: r.pinned === 1,
      createdAt: r.created_at,
    }))
  }

  private requireItem(conversationId: string): void {
    const row = this.db.prepare('SELECT 1 FROM sidebar_items WHERE conversation_id = ?').get(conversationId)
    if (!row) throw notFound('sidebar item', conversationId)
  }

  /** Returns the ids of every conversation whose placement changed. */
  move(conversationId: string, to: SidebarSlot, index?: number): string[] {
    this.requireItem(conversationId)
    if (to.sectionId && !to.pinned) this.getSection(to.sectionId)
    const changes = applySidebarMove(this.orderItems(), { id: conversationId, to, index })
    const update = this.db.prepare(
      'UPDATE sidebar_items SET section_id = ?, position = ?, pinned = ? WHERE conversation_id = ?',
    )
    this.db.transaction(() => {
      for (const [id, patch] of changes) update.run(patch.sectionId, patch.order, bool(patch.pinned), id)
    })()
    return [...changes.keys()]
  }

  setPinned(conversationId: string, pinned: boolean): string[] {
    const item = this.orderItems().find((i) => i.id === conversationId)
    if (!item) throw notFound('sidebar item', conversationId)
    if (item.pinned === pinned) return []
    return this.move(conversationId, { pinned, sectionId: item.sectionId })
  }

  setHidden(conversationId: string, hidden: boolean): void {
    this.requireItem(conversationId)
    this.db
      .prepare('UPDATE sidebar_items SET hidden = ? WHERE conversation_id = ?')
      .run(bool(hidden), conversationId)
  }

  /** Marked unread by the user; reading it (`ConversationStore.markRead`) clears the mark. */
  markUnread(conversationId: string): void {
    this.requireItem(conversationId)
    this.db
      .prepare('UPDATE sidebar_items SET marked_unread = 1 WHERE conversation_id = ?')
      .run(conversationId)
  }
}
