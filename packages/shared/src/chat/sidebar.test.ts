import { describe, expect, it } from 'vitest'

import {
  applySidebarMove,
  containerKey,
  itemsIn,
  PINNED_CONTAINER,
  type SidebarOrderItem,
  type SidebarPatch,
  UNSECTIONED_CONTAINER,
} from './sidebar'

function item(id: string, order: number, extra: Partial<SidebarOrderItem> = {}): SidebarOrderItem {
  return { id, order, pinned: false, sectionId: null, createdAt: order, ...extra }
}

function patchSidebarItems<T extends SidebarOrderItem>(items: T[], changes: Map<string, SidebarPatch>): T[] {
  return items.map((item) => {
    const patch = changes.get(item.id)
    return patch ? { ...item, ...patch } : item
  })
}

const ids = (items: SidebarOrderItem[], key: string) => itemsIn(items, key).map((i) => i.id)

describe('applySidebarMove', () => {
  const base = [
    item('a', 0),
    item('b', 1),
    item('c', 2),
    item('d', 0, { sectionId: 'dev' }),
    item('e', 1, { sectionId: 'dev' }),
    item('p', 0, { pinned: true, sectionId: 'dev' }),
  ]

  it('reorders inside a container', () => {
    const next = patchSidebarItems(
      base,
      applySidebarMove(base, { id: 'c', to: { pinned: false, sectionId: null }, index: 0 }),
    )
    expect(ids(next, UNSECTIONED_CONTAINER)).toEqual(['c', 'a', 'b'])
    expect(itemsIn(next, UNSECTIONED_CONTAINER).map((i) => i.order)).toEqual([0, 1, 2])
  })

  it('moves between sections and renumbers both sides', () => {
    const changes = applySidebarMove(base, { id: 'a', to: { pinned: false, sectionId: 'dev' }, index: 1 })
    const next = patchSidebarItems(base, changes)
    expect(ids(next, 'dev')).toEqual(['d', 'a', 'e'])
    expect(ids(next, UNSECTIONED_CONTAINER)).toEqual(['b', 'c'])
    expect(itemsIn(next, UNSECTIONED_CONTAINER).map((i) => i.order)).toEqual([0, 1])
    expect(changes.has('d')).toBe(false)
  })

  it('appends when no index is given and clamps out-of-range indexes', () => {
    const appended = patchSidebarItems(
      base,
      applySidebarMove(base, { id: 'b', to: { pinned: false, sectionId: 'dev' } }),
    )
    expect(ids(appended, 'dev')).toEqual(['d', 'e', 'b'])
    const clamped = patchSidebarItems(
      base,
      applySidebarMove(base, { id: 'b', to: { pinned: false, sectionId: 'dev' }, index: 99 }),
    )
    expect(ids(clamped, 'dev')).toEqual(['d', 'e', 'b'])
  })

  it('pinning keeps the section so unpinning restores it', () => {
    const pinned = patchSidebarItems(
      base,
      applySidebarMove(base, { id: 'e', to: { pinned: true, sectionId: null } }),
    )
    expect(ids(pinned, PINNED_CONTAINER)).toEqual(['p', 'e'])
    expect(pinned.find((i) => i.id === 'e')?.sectionId).toBe('dev')
    expect(ids(pinned, 'dev')).toEqual(['d'])

    const unpinned = patchSidebarItems(
      pinned,
      applySidebarMove(pinned, { id: 'e', to: { pinned: false, sectionId: 'dev' } }),
    )
    expect(ids(unpinned, 'dev')).toEqual(['d', 'e'])
    expect(ids(unpinned, PINNED_CONTAINER)).toEqual(['p'])
  })

  it('returns no changes for an unknown item or a no-op move', () => {
    expect(applySidebarMove(base, { id: 'zzz', to: { pinned: false, sectionId: null } }).size).toBe(0)
    expect(applySidebarMove(base, { id: 'a', to: { pinned: false, sectionId: null }, index: 0 }).size).toBe(0)
  })

  it('computes the container key', () => {
    expect(containerKey({ pinned: true, sectionId: 'x' })).toBe(PINNED_CONTAINER)
    expect(containerKey({ pinned: false, sectionId: null })).toBe(UNSECTIONED_CONTAINER)
    expect(containerKey({ pinned: false, sectionId: 'x' })).toBe('x')
  })
})
