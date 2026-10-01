import { z } from 'zod'

import { endpoint, Ok } from '../http/endpoint'
import { ConversationSummary } from './conversations'

export const SidebarSection = z.object({
  id: z.string(),
  name: z.string().min(1).max(40),
  order: z.number().int(),
  collapsed: z.boolean(),
})
export type SidebarSection = z.infer<typeof SidebarSection>

/**
 * Sidebar ordering. Items live in one container at a time: the pinned area on top, a user section,
 * or "No section" (`sectionId: null`). `order` is dense (0..n-1) inside each container; pinned items
 * keep their `sectionId` so unpinning puts them back where they were.
 */
export interface SidebarSlot {
  pinned: boolean
  sectionId: string | null
}

export interface SidebarOrderItem extends SidebarSlot {
  id: string
  order: number
  createdAt: number
}

export const PINNED_CONTAINER = '__pinned__'
export const UNSECTIONED_CONTAINER = '__none__'

export function containerKey(slot: SidebarSlot): string {
  if (slot.pinned) return PINNED_CONTAINER
  return slot.sectionId ?? UNSECTIONED_CONTAINER
}

export function slotFromContainer(key: string, previousSectionId: string | null): SidebarSlot {
  if (key === PINNED_CONTAINER) return { pinned: true, sectionId: previousSectionId }
  if (key === UNSECTIONED_CONTAINER) return { pinned: false, sectionId: null }
  return { pinned: false, sectionId: key }
}

export function compareSidebarItems(a: SidebarOrderItem, b: SidebarOrderItem): number {
  return a.order - b.order || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

export function itemsIn(items: SidebarOrderItem[], key: string): SidebarOrderItem[] {
  return items.filter((item) => containerKey(item) === key).sort(compareSidebarItems)
}

export interface SidebarMove {
  id: string
  /** Pinning keeps the item's section so unpinning restores it. */
  to: SidebarSlot
  /** Target index inside the destination container; clamped, `undefined` appends. */
  index?: number
}

export type SidebarPatch = SidebarSlot & { order: number }

/**
 * Moves one item and renumbers the source and destination containers. Returns only the items whose
 * slot or order changed.
 */
export function applySidebarMove(items: SidebarOrderItem[], move: SidebarMove): Map<string, SidebarPatch> {
  const moving = items.find((item) => item.id === move.id)
  const changes = new Map<string, SidebarPatch>()
  if (!moving) return changes

  const fromKey = containerKey(moving)
  const destination: SidebarSlot = move.to.pinned
    ? { pinned: true, sectionId: moving.sectionId }
    : { pinned: false, sectionId: move.to.sectionId }
  const toKey = containerKey(destination)

  const target = itemsIn(items, toKey).filter((item) => item.id !== moving.id)
  const index = Math.max(0, Math.min(move.index ?? target.length, target.length))
  target.splice(index, 0, { ...moving, ...destination })

  const record = (item: SidebarOrderItem, slot: SidebarSlot, order: number) => {
    if (item.order !== order || item.pinned !== slot.pinned || item.sectionId !== slot.sectionId) {
      changes.set(item.id, { pinned: slot.pinned, sectionId: slot.sectionId, order })
    }
  }

  target.forEach((item, order) => {
    const original = items.find((i) => i.id === item.id) as SidebarOrderItem
    record(original, item.id === moving.id ? destination : item, order)
  })
  if (fromKey !== toKey) {
    itemsIn(items, fromKey)
      .filter((item) => item.id !== moving.id)
      .forEach((item, order) => record(item, item, order))
  }
  return changes
}

const CreateSidebarSectionBody = z.object({ name: z.string().trim().min(1).max(40) })
const UpdateSidebarSectionBody = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  collapsed: z.boolean().optional(),
})
const ReorderSidebarSectionsBody = z.object({ sectionIds: z.array(z.string()) })

const UpdateSidebarItemBody = z.object({
  pinned: z.boolean().optional(),
  hidden: z.boolean().optional(),
  unread: z.boolean().optional(),
})

const MoveSidebarItemBody = z.object({
  pinned: z.boolean(),
  sectionId: z.string().nullable(),
  index: z.number().int().nonnegative().optional(),
})

const SECTIONS = '/w/:workspaceId/sidebar/sections'
const ITEM = '/w/:workspaceId/sidebar/items/:conversationId'

export const sidebarEndpoints = {
  listSidebarSections: endpoint({ method: 'GET', path: SECTIONS, response: z.array(SidebarSection) }),
  createSidebarSection: endpoint({
    method: 'POST',
    path: SECTIONS,
    body: CreateSidebarSectionBody,
    response: SidebarSection,
  }),
  updateSidebarSection: endpoint({
    method: 'PATCH',
    path: `${SECTIONS}/:sectionId`,
    body: UpdateSidebarSectionBody,
    response: SidebarSection,
  }),
  /** Its items move to "No section". */
  deleteSidebarSection: endpoint({ method: 'DELETE', path: `${SECTIONS}/:sectionId`, response: Ok }),
  reorderSidebarSections: endpoint({
    method: 'POST',
    path: `${SECTIONS}/reorder`,
    body: ReorderSidebarSectionsBody,
    response: z.array(SidebarSection),
  }),
  updateSidebarItem: endpoint({
    method: 'PATCH',
    path: ITEM,
    body: UpdateSidebarItemBody,
    response: ConversationSummary,
  }),
  /** Returns every conversation whose placement changed. */
  moveSidebarItem: endpoint({
    method: 'POST',
    path: `${ITEM}/move`,
    body: MoveSidebarItemBody,
    response: z.array(ConversationSummary),
  }),
}
