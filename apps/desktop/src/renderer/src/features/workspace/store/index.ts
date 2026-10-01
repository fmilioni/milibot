import type { ConversationSummary, WorkspaceSummary } from '@milibot/shared'
import { create } from 'zustand'

import { createStoreContext } from './context'
import { botsSlice } from './slices/bots'
import { connectionSlice } from './slices/connection'
import { conversationsSlice } from './slices/conversations'
import { navigationSlice } from './slices/navigation'
import { uiSlice } from './slices/ui'
import { workspaceSlice } from './slices/workspace'
import type { AppState } from './types'

export { copyWithToast, toastOnError } from './toast'
export type { AppState, ToastKey } from './types'
export type {
  CanvasScreen,
  NavScreen,
  RightPanel,
  Screen,
  SessionScreen,
  SettingsSection,
} from '@/features/workspace/lib/navigation'
export { isNavScreen, screenIs } from '@/features/workspace/lib/navigation'

/** Builds the app store from its slices (one store, so selectors can read across them). */
export function createAppStore() {
  return create<AppState>()((set, get) => {
    const ctx = createStoreContext(set, get)
    return {
      ...connectionSlice(ctx),
      ...workspaceSlice(ctx),
      ...botsSlice(ctx),
      ...conversationsSlice(ctx),
      ...navigationSlice(ctx),
      ...uiSlice(ctx),
    }
  })
}

export const useAppStore = createAppStore()

export function useCurrentWorkspace(): WorkspaceSummary | undefined {
  return useAppStore((s) => s.workspaces.find((w) => w.id === s.workspaceId))
}

export function useSelectedConversation(): ConversationSummary | undefined {
  return useAppStore((s) =>
    s.selectedConversationId ? s.conversations[s.selectedConversationId] : undefined,
  )
}

/** The conversation on screen: a work session's own conversation while its screen is open. */
export function useActiveConversation(): ConversationSummary | undefined {
  return useAppStore((s) => {
    const id = s.screen.kind === 'session' ? s.screen.conversationId : s.selectedConversationId
    return id ? s.conversations[id] : undefined
  })
}
