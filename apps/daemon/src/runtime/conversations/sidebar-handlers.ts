import type { sidebarEndpoints, WorkspaceEvent } from '@milibot/shared'

import type { EndpointHandlers } from '../../handlers'
import type { WorkspaceStore } from '../workspace-store'
import { SidebarStore } from './sidebar-store'

export interface SidebarRoutesDeps {
  store: WorkspaceStore
  emit: (event: WorkspaceEvent) => void
  now: () => number
}

/** Sections, order, pin, hide and unread marks of the sidebar. */
export class SidebarRoutes {
  constructor(private readonly deps: SidebarRoutesDeps) {}

  handlers() {
    const { store, emit, now } = this.deps
    const sidebar = new SidebarStore(store.db, now)
    const emitSections = () =>
      emit({ type: 'sidebar.sections', payload: { sections: sidebar.listSections() } })
    const emitConversations = (ids: Iterable<string>) => {
      const summaries = [...new Set(ids)].map((id) => store.conversations.get(id))
      for (const conversation of summaries) emit({ type: 'conversation.updated', payload: { conversation } })
      return summaries
    }

    return {
      listSidebarSections: () => sidebar.listSections(),

      createSidebarSection: ({ body }) => {
        const section = sidebar.createSection(body.name)
        emitSections()
        return section
      },

      updateSidebarSection: ({ params, body }) => {
        const section = sidebar.updateSection(params.sectionId, body)
        emitSections()
        return section
      },

      deleteSidebarSection: ({ params }) => {
        const moved = sidebar.deleteSection(params.sectionId)
        emitSections()
        emitConversations(moved)
        return { ok: true as const }
      },

      reorderSidebarSections: ({ body }) => {
        const sections = sidebar.reorderSections(body.sectionIds)
        emitSections()
        return sections
      },

      updateSidebarItem: ({ params, body }) => {
        const { conversationId } = params
        const changed = new Set<string>([conversationId])
        if (body.pinned !== undefined)
          for (const id of sidebar.setPinned(conversationId, body.pinned)) changed.add(id)
        if (body.hidden !== undefined) sidebar.setHidden(conversationId, body.hidden)
        if (body.unread === true) sidebar.markUnread(conversationId)
        else if (body.unread === false) store.conversations.markRead(conversationId)
        emitConversations(changed)
        return store.conversations.get(conversationId)
      },

      moveSidebarItem: ({ params, body }) => {
        const changed = sidebar.move(
          params.conversationId,
          { pinned: body.pinned, sectionId: body.sectionId },
          body.index,
        )
        return emitConversations(changed)
      },
    } satisfies EndpointHandlers<keyof typeof sidebarEndpoints>
  }
}
