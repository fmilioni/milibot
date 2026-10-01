import {
  compareSidebarItems,
  type ConversationSummary,
  PINNED_CONTAINER,
  type SidebarOrderItem,
  type SidebarSection,
  UNSECTIONED_CONTAINER,
} from '@milibot/shared'

type SidebarGroupKind = 'pinned' | 'section' | 'bots' | 'groups'

export interface SidebarGroup {
  /** Unique list id (the two "No section" lists share one container). */
  key: string
  kind: SidebarGroupKind
  container: string
  section: SidebarSection | null
  conversations: ConversationSummary[]
}

function orderItem(c: ConversationSummary): SidebarOrderItem {
  return {
    id: c.id,
    pinned: c.sidebar.pinned,
    sectionId: c.sidebar.sectionId,
    order: c.sidebar.order,
    createdAt: c.createdAt,
  }
}

function sortConversations(list: ConversationSummary[]): ConversationSummary[] {
  return [...list].sort((a, b) => compareSidebarItems(orderItem(a), orderItem(b)))
}

/** The sidebar's items as `applySidebarMove` sees them (internal and session conversations left out). */
export function sidebarOrderItems(conversations: Record<string, ConversationSummary>): SidebarOrderItem[] {
  return Object.values(conversations)
    .filter((c) => c.type !== 'internal' && c.type !== 'session')
    .map(orderItem)
}

/**
 * Pinned on top, then the user's sections (kept even when empty so items can be dropped there),
 * then "No section" split into bots and groups. Hidden and internal conversations are
 * left out unless `includeHidden` (search results).
 */
export function groupSidebar(
  conversations: ConversationSummary[],
  sections: SidebarSection[],
  options: { includeHidden?: boolean; keepEmptySections?: boolean } = {},
): SidebarGroup[] {
  const visible = conversations.filter(
    (c) => c.type !== 'internal' && c.type !== 'session' && (options.includeHidden || !c.sidebar.hidden),
  )
  const knownSections = new Set(sections.map((s) => s.id))
  const sectionOf = (c: ConversationSummary) =>
    c.sidebar.sectionId && knownSections.has(c.sidebar.sectionId) ? c.sidebar.sectionId : null
  const unpinned = visible.filter((c) => !c.sidebar.pinned)
  const unsectioned = sortConversations(unpinned.filter((c) => sectionOf(c) === null))

  const groups: SidebarGroup[] = [
    {
      key: PINNED_CONTAINER,
      kind: 'pinned',
      container: PINNED_CONTAINER,
      section: null,
      conversations: sortConversations(visible.filter((c) => c.sidebar.pinned)),
    },
    ...[...sections]
      .sort((a, b) => a.order - b.order)
      .map((section) => ({
        key: section.id,
        kind: 'section' as const,
        container: section.id,
        section,
        conversations: sortConversations(unpinned.filter((c) => sectionOf(c) === section.id)),
      })),
    {
      key: 'bots',
      kind: 'bots',
      container: UNSECTIONED_CONTAINER,
      section: null,
      conversations: unsectioned.filter((c) => c.type === 'direct'),
    },
    {
      key: 'groups',
      kind: 'groups',
      container: UNSECTIONED_CONTAINER,
      section: null,
      conversations: unsectioned.filter((c) => c.type === 'group'),
    },
  ]
  return groups.filter(
    (g) => g.conversations.length > 0 || (g.kind === 'section' && options.keepEmptySections),
  )
}
