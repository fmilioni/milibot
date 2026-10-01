import { api } from '@/api/daemon'
import {
  type BotScreen,
  screenKey,
  screenNavigationChanged,
  screensToRelease,
  shownScreen,
} from '@/features/vm/lib/screen-control'
import { useTeachStore } from '@/features/vm/teach-store'
import { visibleConversationId } from '@/features/workspace/lib/navigation'

import { useAppStore } from './index'
import { takenOverHere } from './taken-over'

async function releaseScreen(screen: BotScreen): Promise<void> {
  takenOverHere.delete(screenKey(screen))
  const params = { workspaceId: screen.workspaceId, botId: screen.botId }
  const display = await api().call('getBotDisplay', { params })
  if (display.control === 'user') await api().call('controlBot', { params, body: { action: 'release' } })
}

/** Screens taken over from this window go back to their bots once the window stops showing them. */
function releaseScreensOutOfView(): () => void {
  return useAppStore.subscribe((state, previous) => {
    if (takenOverHere.size === 0 || !screenNavigationChanged(state, previous)) return
    // The teach recording keeps the screen it records and gives it back itself when it ends.
    const teachingBotId = useTeachStore.getState().session?.botId
    const teaching =
      teachingBotId && state.workspaceId ? { workspaceId: state.workspaceId, botId: teachingBotId } : null
    for (const screen of screensToRelease({ takenOver: takenOverHere, shown: shownScreen(state), teaching }))
      void releaseScreen(screen).catch(() => undefined)
  })
}

/** A notification's conversation: a session's own conversation opens the session screen. */
async function showConversation(workspaceId: string, conversationId: string): Promise<void> {
  const state = useAppStore.getState()
  const conversation = await state.ensureConversation(conversationId)
  if (conversation.type !== 'session') {
    await state.openConversation(conversationId)
    return
  }
  const botId = conversation.memberBotIds[0]
  const sessions = await api().call('listWorkSessions', {
    params: { workspaceId },
    query: botId ? { botId } : {},
  })
  const session = sessions.find((s) => s.conversationId === conversationId)
  if (session) await state.openWorkSession(session.id)
}

/**
 * The workspace window's link with the main process: clicked notifications show their conversation once
 * the workspace has loaded, and the conversation on screen is reported (its notifications are skipped).
 */
function followNotifications(): () => void {
  let pendingShow: { workspaceId: string; conversationId: string } | null = null
  const showPending = () => {
    const state = useAppStore.getState()
    if (!pendingShow || state.phase !== 'ready' || state.workspaceId !== pendingShow.workspaceId) return
    const { workspaceId, conversationId } = pendingShow
    pendingShow = null
    void showConversation(workspaceId, conversationId).catch(() => undefined)
  }
  window.milibot.onShowConversation((workspaceId, conversationId) => {
    pendingShow = { workspaceId, conversationId }
    showPending()
  })
  let reported: string | null = null
  return useAppStore.subscribe((state) => {
    showPending()
    const active = state.phase === 'ready' ? visibleConversationId(state) : null
    if (active === reported) return
    reported = active
    window.milibot.setActiveConversation(active)
  })
}

/** The app store's window-level effects; the workspace window also follows notifications. */
export function registerAppEffects(): void {
  releaseScreensOutOfView()
  if (window.milibot.windowKind === 'workspace') followNotifications()
}
