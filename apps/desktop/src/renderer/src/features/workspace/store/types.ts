import type {
  AnswerSecretBody,
  AppSettings,
  Avatar,
  AvatarColor,
  Bot,
  BotActivityAction,
  BotControlAction,
  BotControlOptions,
  BotPromptDraft,
  CliUsage,
  CloseBehavior,
  ConversationSummary,
  CopyWorkspaceOptions,
  GenerateBotPromptBody,
  GroupSettings,
  QuestionAnswer,
  RuntimeStatus,
  SetupStep,
  SetupVmBody,
  SidebarSection,
  SidebarSlot,
  UpdateBotBody,
  UpdateWorkspaceBody,
  VmInfo,
  WorkspaceEvent,
  WorkspaceStatus,
  WorkspaceSummary,
} from '@milibot/shared'

import type { StatusDetail } from '@/features/bots/lib/bot-status'
import type {
  PanelSection,
  RightPanel,
  Screen,
  ScreenTarget,
  SettingsSection,
} from '@/features/workspace/lib/navigation'
import type { MessageThread, PendingReply } from '@/features/workspace/lib/threads'
import type ptBR from '@/i18n/locales/pt-BR'

export type ToastKey = keyof (typeof ptBR)['toast']

type ModalState =
  | { type: 'newBot' }
  | { type: 'newGroup' }
  | { type: 'newWorkspace' }
  | { type: 'newSection'; moveConversationId?: string }
  | { type: 'confirmDelete'; conversationId: string }

type ConnectionState = 'connecting' | 'online' | 'offline'

interface NewBotInput {
  name: string
  label: string
  /** The persona ("Generate prompt" in the modal, reviewed by the user); empty = the default role. */
  systemPrompt: string
  avatar: Avatar
  sectionId: string | null
  /** null = the provider's default model. */
  model?: string | null
}

export interface ConnectionSlice {
  phase: 'booting' | 'ready' | 'error'
  bootError: string | null
  connectionState: ConnectionState
  /** `chat: false`: a window without the chat (the canvas window) selects and marks no conversation. */
  boot(options?: { chat?: boolean }): Promise<void>
  /** Where the workspace stream's events land (the dev hook injects through it too). */
  receiveWorkspaceEvent(event: WorkspaceEvent): void
}

export interface WorkspaceSlice {
  workspaceId: string | null
  workspaces: WorkspaceSummary[]
  appSettings: AppSettings
  runtimeStatus: RuntimeStatus
  status: WorkspaceStatus | null
  vm: VmInfo | null
  /** Subscription quota of each CLI provider. */
  cliUsage: Record<string, CliUsage>

  switchWorkspace(workspaceId: string): Promise<void>
  /** Creates a workspace that starts at the setup screens and shows it in this window. */
  createWorkspace(input: {
    name: string
    color: AvatarColor
    closeBehavior: CloseBehavior
    copyFrom?: CopyWorkspaceOptions
  }): Promise<void>
  /** Moves this window's workspace to another setup screen (`done` shows the chat). */
  updateSetup(step: SetupStep): Promise<void>
  /** Saves the VM size and starts creating the machine. */
  setupVm(size: SetupVmBody): Promise<void>
  openWorkspaceInNewWindow(workspaceId: string): void
  updateWorkspace(workspaceId: string, patch: UpdateWorkspaceBody): Promise<void>
  /** Deletes a workspace (VM, disks, data, keys); a window showing it moves to another one. */
  deleteWorkspace(workspaceId: string): Promise<void>
  updateAppSettings(patch: Partial<AppSettings>): Promise<void>
  refreshVm(): Promise<void>
  startVm(): Promise<void>
  /** Zeroes the footer spend counter (history is kept). */
  resetUsageCounter(): Promise<void>
  /** Lets the bots work again after the daily spend limit paused them. */
  resumeSpend(): Promise<void>
}

export interface BotsSlice {
  bots: Record<string, Bot>
  /** What each busy bot is doing (see `nextStatusDetail`). */
  statusDetail: Record<string, StatusDetail | undefined>
  /** Bots just asked to reply, until the daemon reports a status for them (optimistic "working"). */
  pendingReplies: Record<string, PendingReply | undefined>
  /** Conversation each bot last acted in, to place its "working" row. */
  botConversation: Record<string, string | undefined>
  /** Work session each bot's status comes from while its chat lane is idle (`bot.status` `sessionId`). */
  statusSession: Record<string, string | undefined>
  activity: Record<string, BotActivityAction[]>

  createBot(input: NewBotInput): Promise<void>
  generateBotPrompt(input: GenerateBotPromptBody): Promise<BotPromptDraft>
  updateBot(botId: string, patch: UpdateBotBody): Promise<void>
  controlBot(botId: string, action: BotControlAction, options?: BotControlOptions): Promise<void>
  loadActivity(botId: string): Promise<void>
}

export interface ConversationsSlice {
  conversations: Record<string, ConversationSummary>
  sections: SidebarSection[]
  threads: Record<string, MessageThread>
  selectedConversationId: string | null

  /** Shows the conversation in the chat (leaving any other screen). */
  selectConversation(conversationId: string): void
  /** The conversation, fetched and kept when the store doesn't know it yet (e.g. internal bot↔bot threads). */
  ensureConversation(conversationId: string): Promise<ConversationSummary>
  /** Selects a conversation that may not be in the sidebar (internal bot↔bot threads). */
  openConversation(conversationId: string): Promise<void>
  loadOlderMessages(conversationId: string): Promise<void>
  /** Loads the latest messages again (after a failed load). */
  reloadConversation(conversationId: string): void
  sendMessage(conversationId: string, content: string, attachmentIds?: string[]): Promise<void>

  moveConversation(conversationId: string, to: SidebarSlot, index?: number): Promise<void>
  setPinned(conversationId: string, pinned: boolean): Promise<void>
  setHidden(conversationId: string, hidden: boolean): Promise<void>
  markUnread(conversationId: string): Promise<void>
  renameConversation(conversationId: string, name: string): Promise<void>
  deleteConversation(conversationId: string): Promise<void>
  createSection(name: string): Promise<SidebarSection>
  updateSection(sectionId: string, patch: { name?: string; collapsed?: boolean }): Promise<void>
  deleteSection(sectionId: string): Promise<void>
  reorderSections(sectionIds: string[]): Promise<void>

  createGroup(botIds: string[], title: string | null): Promise<void>
  updateGroupSettings(conversationId: string, patch: Partial<GroupSettings>): Promise<void>
  addGroupMember(conversationId: string, botId: string): Promise<void>
  removeGroupMember(conversationId: string, botId: string): Promise<void>
  resolveConfirmation(confirmationId: string, approved: boolean): Promise<void>
  /** The secret value is only passed through to the daemon, never kept in the store. */
  answerSecretRequest(requestId: string, body: AnswerSecretBody): Promise<void>
  answerQuestion(requestId: string, answers: QuestionAnswer[]): Promise<void>
  declineUserRequest(requestId: string): Promise<void>
}

export interface NavigationSlice {
  /** What the window's center shows (`navigate` is the only writer). */
  screen: Screen
  rightPanel: RightPanel | null
  panelSection: PanelSection | null
  /** Bot↔bot conversation shown read-only in the right panel. */
  internalConversationId: string | null
  /** Bot whose screen the VM panel shows instead of the selected conversation's ("View screen" of another bot). */
  vmBotId: string | null

  navigate(target: ScreenTarget): void
  openSettings(section?: SettingsSection): void
  closeSettings(): void
  /** Shows a work session full window (its conversation, steps and changes). */
  openWorkSession(sessionId: string): Promise<void>
  /** Leaves the session screen for the chat it started from. */
  closeWorkSession(): void
  /** Shows a design's canvas next to `conversationId` (its chat), selecting that conversation. */
  openCanvas(designId: string, conversationId: string | null): Promise<void>
  closeCanvas(): void
  toggleCanvasSidebar(): void
  /** Shows the boards (a board, or the list's first one). */
  openBoards(boardId?: string | null): void
  openDesigns(): void
  openFiles(): void
  closeNavScreen(): void
  toggleRightPanel(panel: RightPanel): void
  openRightPanel(panel: RightPanel, section?: PanelSection): void
  clearPanelSection(): void
  /** Opens the VM panel on a given bot's screen. */
  showBotScreen(botId: string): void
  /** Shows an internal bot↔bot conversation in the right panel (read-only). */
  openInternalConversation(conversationId: string): Promise<void>
}

export interface UiSlice {
  toast: ToastKey | null
  modal: ModalState | null
  search: string
  renamingConversationId: string | null

  showToast(key: ToastKey): void
  setModal(modal: ModalState | null): void
  setSearch(search: string): void
  setRenaming(conversationId: string | null): void
}

export type AppState = ConnectionSlice &
  WorkspaceSlice &
  BotsSlice &
  ConversationsSlice &
  NavigationSlice &
  UiSlice
