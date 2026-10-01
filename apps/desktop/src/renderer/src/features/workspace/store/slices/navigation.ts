import { api } from '@/api/daemon'
import {
  canvasScreenFor,
  CHAT_SCREEN,
  enterScreen,
  isNavScreen,
  screenIs,
} from '@/features/workspace/lib/navigation'

import type { StoreContext } from '../context'
import type { NavigationSlice } from '../types'

export function navigationSlice(ctx: StoreContext): NavigationSlice {
  const { get, set, ws, threads } = ctx

  /** The canvas has no right panel: showing one there goes back to the chat. */
  const leaveCanvas = () => {
    if (get().screen.kind === 'canvas') get().navigate(CHAT_SCREEN)
  }

  return {
    screen: CHAT_SCREEN,
    rightPanel: 'vm',
    panelSection: null,
    internalConversationId: null,
    vmBotId: null,

    navigate(target) {
      set(enterScreen(get(), target))
    },

    openSettings(section = 'general') {
      get().navigate({ kind: 'settings', section })
    },

    closeSettings() {
      if (get().screen.kind === 'settings') get().navigate(CHAT_SCREEN)
    },

    async openWorkSession(sessionId) {
      const session = await api().call('getWorkSession', { params: { workspaceId: ws(), sessionId } })
      await get().ensureConversation(session.conversationId)
      get().navigate({
        kind: 'session',
        sessionId,
        conversationId: session.conversationId,
        originConversationId: session.originConversationId,
        botId: session.botId,
      })
      await threads.loadLatest(session.conversationId).catch(() => undefined)
    },

    closeWorkSession() {
      const screen = screenIs(get().screen, 'session')
      if (!screen) return
      get().navigate(CHAT_SCREEN)
      if (get().conversations[screen.originConversationId]) ctx.pickConversation(screen.originConversationId)
    },

    async openCanvas(designId, conversationId) {
      const before = get()
      if (conversationId && conversationId !== before.selectedConversationId)
        await get().openConversation(conversationId)
      const selected = get().selectedConversationId
      const shownType = selected ? get().conversations[selected]?.type : undefined
      get().navigate(canvasScreenFor(designId, before, shownType))
    },

    closeCanvas() {
      const screen = screenIs(get().screen, 'canvas')
      if (!screen) return
      get().navigate(screen.backNav ?? CHAT_SCREEN)
      const back = screen.backNav ? undefined : screen.back
      if (!back) return
      if (back.conversationId && get().conversations[back.conversationId])
        ctx.pickConversation(back.conversationId)
      if (back.sessionId)
        void get()
          .openWorkSession(back.sessionId)
          .catch(() => undefined)
    },

    toggleCanvasSidebar() {
      const screen = screenIs(get().screen, 'canvas')
      if (screen) get().navigate({ ...screen, sidebar: !screen.sidebar })
    },

    openBoards(boardId = null) {
      get().navigate({ kind: 'boards', boardId })
    },

    openDesigns() {
      get().navigate({ kind: 'designs' })
    },

    openFiles() {
      get().navigate({ kind: 'files' })
    },

    closeNavScreen() {
      if (isNavScreen(get().screen)) get().navigate(CHAT_SCREEN)
    },

    toggleRightPanel(panel) {
      set({ rightPanel: get().rightPanel === panel ? null : panel, vmBotId: null })
    },

    openRightPanel(panel, section) {
      leaveCanvas()
      set({ rightPanel: panel, panelSection: section ?? null, vmBotId: null })
    },

    clearPanelSection() {
      set({ panelSection: null })
    },

    showBotScreen(botId) {
      leaveCanvas()
      set({ rightPanel: 'vm', vmBotId: botId })
    },

    async openInternalConversation(conversationId) {
      await get().ensureConversation(conversationId)
      leaveCanvas()
      set({ internalConversationId: conversationId, rightPanel: 'internal' })
      await threads.loadLatest(conversationId).catch(() => undefined)
    },
  }
}
