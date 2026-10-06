export type RightPanel = 'vm' | 'debug' | 'settings' | 'bot' | 'members' | 'internal'
/** A part of a right panel to bring into view once it renders. */
export type PanelSection = 'routines'

/** Sections of the full-window settings screen. */
export type SettingsSection =
  | 'general'
  | 'providers'
  | 'vm'
  | 'credentials'
  | 'mcp'
  | 'skills'
  | 'projects'
  | 'knowledge'
  | 'plans'
  | 'sessions'
  | 'memory'
  | 'costs'
  | 'workspaces'
  | 'appearance'

/**
 * Screens the rows at the top of the sidebar open instead of the chat; `boardId` null: the first board;
 * `cardId`: a card whose dialog the board opens once (then drops it from the screen).
 */
export type NavScreen =
  { kind: 'boards'; boardId: string | null; cardId?: string } | { kind: 'designs' } | { kind: 'files' }

/** Where closing a canvas opened from a work session's conversation goes back to. */
interface CanvasBack {
  sessionId: string | null
  conversationId: string | null
}

/** A work session shown full window instead of the chat. */
export interface SessionScreen {
  kind: 'session'
  sessionId: string
  conversationId: string
  originConversationId: string
  botId: string
  /** Right panel open before the session screen, shown again when it closes. */
  restorePanel: RightPanel | null
}

/** A design's canvas shown full window, next to its conversation. */
export interface CanvasScreen {
  kind: 'canvas'
  designId: string
  /** The sidebar shown next to the canvas (hidden by default for room). */
  sidebar: boolean
  back?: CanvasBack
  /** The sidebar screen it was opened from (the designs list), shown again on close. */
  backNav?: NavScreen
}

/** What the main window's center shows. The setup screens are not here: they follow the workspace's setup step. */
export type Screen =
  { kind: 'chat' } | { kind: 'settings'; section: SettingsSection } | SessionScreen | CanvasScreen | NavScreen

export type ScreenKind = Screen['kind']

/** A screen to go to; the session's `restorePanel` is filled in by `enterScreen`. */
export type ScreenTarget = Exclude<Screen, SessionScreen> | Omit<SessionScreen, 'restorePanel'>

export const CHAT_SCREEN: Screen = { kind: 'chat' }

export function screenIs<K extends ScreenKind>(screen: Screen, kind: K): Extract<Screen, { kind: K }> | null {
  return screen.kind === kind ? (screen as Extract<Screen, { kind: K }>) : null
}

export function isNavScreen(screen: Screen): screen is NavScreen {
  return screen.kind === 'boards' || screen.kind === 'designs' || screen.kind === 'files'
}

interface NavigationState {
  screen: Screen
  rightPanel: RightPanel | null
}

/**
 * Going to `target`: the session screen starts on its own tabs, keeping the right panel open before it
 * (moving between sessions keeps the first one), and leaving it brings that panel back.
 */
export function enterScreen(state: NavigationState, target: ScreenTarget): NavigationState {
  const from = state.screen
  const before = from.kind === 'session' ? from.restorePanel : state.rightPanel
  if (target.kind === 'session') return { screen: { ...target, restorePanel: before }, rightPanel: null }
  return { screen: target, rightPanel: before }
}

/**
 * The canvas screen for `designId`, opened from `before`. Closing it goes back to the sidebar screen it was
 * opened from, or (only for a work session's conversation, a chat inside the session screen) to that
 * session or the conversation selected before. Switching designs keeps the first answers and the sidebar.
 */
export function canvasScreenFor(
  designId: string,
  before: { screen: Screen; selectedConversationId: string | null },
  shownConversationType: string | undefined,
): CanvasScreen {
  const previous = screenIs(before.screen, 'canvas')
  const session = screenIs(before.screen, 'session')
  const back =
    shownConversationType === 'session'
      ? (previous?.back ?? {
          sessionId: session?.sessionId ?? null,
          conversationId: before.selectedConversationId,
        })
      : undefined
  const backNav = previous ? previous.backNav : isNavScreen(before.screen) ? before.screen : undefined
  return {
    kind: 'canvas',
    designId,
    sidebar: previous?.sidebar ?? false,
    ...(back ? { back } : {}),
    ...(backNav ? { backNav } : {}),
  }
}

/** The conversation on screen that notifications should skip (none on the settings or sidebar screens). */
export function visibleConversationId(state: {
  screen: Screen
  selectedConversationId: string | null
}): string | null {
  switch (state.screen.kind) {
    case 'session':
      return state.screen.conversationId
    case 'chat':
    case 'canvas':
      return state.selectedConversationId
    default:
      return null
  }
}
