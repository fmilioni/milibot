import type { WorkspaceEvent } from '@milibot/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import { SidebarRoutes } from '../../../src/runtime/conversations/sidebar-handlers'
import { SidebarStore } from '../../../src/runtime/conversations/sidebar-store'
import { WorkspaceStore } from '../../../src/runtime/workspace-store'
import { openWorkspaceDb } from '../../../src/workspace-db/open'

let store: WorkspaceStore
let sidebar: SidebarStore
let events: WorkspaceEvent[]
let handlers: ReturnType<SidebarRoutes['handlers']>

function dm(name: string): string {
  const bot = store.bots.create({ name })
  return store.conversations.create({ type: 'direct', botIds: [bot.id] }).id
}

beforeEach(() => {
  const db = openWorkspaceDb(':memory:')
  let clock = 1_000
  const now = () => clock++
  store = new WorkspaceStore(db, now)
  sidebar = new SidebarStore(db, now)
  events = []
  handlers = new SidebarRoutes({ store, emit: (e) => events.push(e), now }).handlers()
})

const workspaceId = 'ws_test'

describe('sidebar sections', () => {
  it('creates, renames, reorders and deletes sections, emitting the full list', () => {
    const dev = handlers.createSidebarSection({
      params: { workspaceId },
      query: undefined,
      body: { name: 'Dev' },
    })
    const times = handlers.createSidebarSection({
      params: { workspaceId },
      query: undefined,
      body: { name: 'Times' },
    })
    expect(sidebar.listSections().map((s) => s.name)).toEqual(['Dev', 'Times'])

    handlers.updateSidebarSection({
      params: { workspaceId, sectionId: dev.id },
      query: undefined,
      body: { name: 'Engenharia', collapsed: true },
    })
    handlers.reorderSidebarSections({
      params: { workspaceId },
      query: undefined,
      body: { sectionIds: [times.id] },
    })
    expect(sidebar.listSections().map((s) => [s.name, s.collapsed])).toEqual([
      ['Times', false],
      ['Engenharia', true],
    ])
    expect(events.at(-1)?.type).toBe('sidebar.sections')

    const a = dm('A')
    handlers.moveSidebarItem({
      params: { workspaceId, conversationId: a },
      query: undefined,
      body: { pinned: false, sectionId: dev.id },
    })
    handlers.deleteSidebarSection({
      params: { workspaceId, sectionId: dev.id },
      query: undefined,
      body: undefined,
    })
    expect(sidebar.listSections()).toHaveLength(1)
    expect(store.conversations.get(a).sidebar.sectionId).toBeNull()
  })
})

describe('sidebar items', () => {
  it('moves items between containers and returns every changed conversation', () => {
    const a = dm('A')
    const b = dm('B')
    const c = dm('C')
    const dev = sidebar.createSection('Dev')

    const changed = handlers.moveSidebarItem({
      params: { workspaceId, conversationId: a },
      query: undefined,
      body: { pinned: false, sectionId: dev.id, index: 0 },
    })
    expect(changed.map((conv) => conv.id).sort()).toEqual([a, b, c].sort())
    expect(store.conversations.get(a).sidebar).toMatchObject({ sectionId: dev.id, order: 0 })
    expect(store.conversations.get(b).sidebar.order).toBe(0)
    expect(store.conversations.get(c).sidebar.order).toBe(1)

    handlers.moveSidebarItem({
      params: { workspaceId, conversationId: c },
      query: undefined,
      body: { pinned: false, sectionId: null, index: 0 },
    })
    expect(store.conversations.get(c).sidebar.order).toBe(0)
    expect(store.conversations.get(b).sidebar.order).toBe(1)
  })

  it('pins, hides and marks as unread', () => {
    const a = dm('A')
    const dev = sidebar.createSection('Dev')
    sidebar.move(a, { pinned: false, sectionId: dev.id })

    let summary = handlers.updateSidebarItem({
      params: { workspaceId, conversationId: a },
      query: undefined,
      body: { pinned: true },
    })
    expect(summary.sidebar).toMatchObject({ pinned: true, sectionId: dev.id })

    summary = handlers.updateSidebarItem({
      params: { workspaceId, conversationId: a },
      query: undefined,
      body: { pinned: false, hidden: true, unread: true },
    })
    expect(summary.sidebar).toMatchObject({ pinned: false, sectionId: dev.id, hidden: true, unreadCount: 1 })

    summary = handlers.updateSidebarItem({
      params: { workspaceId, conversationId: a },
      query: undefined,
      body: { unread: false, hidden: false },
    })
    expect(summary.sidebar).toMatchObject({ hidden: false, unreadCount: 0 })
    expect(events.filter((e) => e.type === 'conversation.updated').length).toBeGreaterThan(0)
  })
})
