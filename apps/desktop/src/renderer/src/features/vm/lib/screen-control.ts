import type { Bot, ConversationSummary } from '@milibot/shared'

import { describeConversation } from '@/features/chat/lib/conversation'

/** A bot's screen in one workspace. */
export interface BotScreen {
  workspaceId: string
  botId: string
}

export const screenKey = (screen: BotScreen): string => `${screen.workspaceId}:${screen.botId}`

export function parseScreenKey(key: string): BotScreen {
  const at = key.indexOf(':')
  return { workspaceId: key.slice(0, at), botId: key.slice(at + 1) }
}

/**
 * Bot whose screen the VM panel shows: the one picked with "View screen", else the work session's
 * bot, else the conversation's (a group's busy member, else its first).
 */
export function vmPanelBot(input: {
  conversation: ConversationSummary | undefined
  bots: Record<string, Bot>
  vmBotId: string | null
  sessionBotId?: string | null
}): Bot | null {
  const { conversation, bots, vmBotId, sessionBotId } = input
  const display = conversation ? describeConversation(conversation, bots, '') : null
  return (
    (vmBotId ? bots[vmBotId] : undefined) ??
    (sessionBotId ? bots[sessionBotId] : undefined) ??
    display?.primaryBot ??
    display?.members.find((m) => m.status !== 'idle') ??
    display?.members[0] ??
    null
  )
}

export interface ScreenViewState {
  workspaceId: string | null
  rightPanel: string | null
  /** The chat and the session screen show the right panel; the others cover it. */
  screen: { kind: string; botId?: string }
  vmBotId: string | null
  selectedConversationId: string | null
  conversations: Record<string, ConversationSummary>
  bots: Record<string, Bot>
}

/** The bot screen on display in the window's VM panel (null: the panel is hidden). */
export function shownScreen(state: ScreenViewState): BotScreen | null {
  const { screen } = state
  if (
    !state.workspaceId ||
    state.rightPanel !== 'vm' ||
    (screen.kind !== 'chat' && screen.kind !== 'session')
  )
    return null
  const bot = vmPanelBot({
    conversation: state.selectedConversationId
      ? state.conversations[state.selectedConversationId]
      : undefined,
    bots: state.bots,
    vmBotId: state.vmBotId,
    sessionBotId: screen.kind === 'session' ? (screen.botId ?? null) : null,
  })
  return bot ? { workspaceId: state.workspaceId, botId: bot.id } : null
}

/** Navigation that can take a bot's screen out of the VM panel. */
export function screenNavigationChanged(state: ScreenViewState, previous: ScreenViewState): boolean {
  return (
    state.workspaceId !== previous.workspaceId ||
    state.rightPanel !== previous.rightPanel ||
    state.vmBotId !== previous.vmBotId ||
    state.selectedConversationId !== previous.selectedConversationId ||
    state.screen !== previous.screen
  )
}

/**
 * Screens the user took over from this window and no longer looks at: they go back to their bots.
 * The screen still on display and the one being taught (the recording gives it back) stay.
 */
export function screensToRelease(input: {
  takenOver: Iterable<string>
  shown: BotScreen | null
  teaching: BotScreen | null
}): BotScreen[] {
  const keep = new Set([input.shown, input.teaching].flatMap((s) => (s ? [screenKey(s)] : [])))
  return [...input.takenOver].filter((key) => !keep.has(key)).map(parseScreenKey)
}
