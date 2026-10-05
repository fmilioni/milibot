import {
  type Bot,
  type BotActivityAction,
  type BotStatus,
  type CliEngine,
  type ConversationSummary,
  type Language,
  type Message,
  newId,
} from '@milibot/shared'

import type { GuestCliBackend } from '../cli/backend'
import type { CliMcpConfig } from '../cli/mcp-config'
import type {
  ActivePlan,
  AgentEnvironment,
  BotWorkState,
  ConfirmationRequest,
  KnowledgeContext,
  LlmCallRecord,
  ModelRequestResult,
  ProjectDirectory,
  RepoInstructionFile,
  ResolvedModel,
  ScreenState,
  ToolCallFinish,
  ToolCallStart,
  ToolExecContext,
  ToolInputDraftContext,
  ToolResult,
  TurnFinishedInfo,
} from '../environment'
import { settingsHostState } from '../host/settings'
import { MemoryBlobStore } from '../llm/blobs'
import type { ToolCall } from '../llm/messages'
import type { LLMProvider } from '../llm/provider'
import type { BotMcpToolSet } from '../mcp/tools'
import { solidPng } from '../media/png'
import type { SkillContext } from '../skills/context'
import { TOOL_FAMILY_NAMES } from '../tools/policy'
import { InMemoryMemory } from './in-memory'
import { InMemorySetAside } from './set-aside'
import { InMemoryWorkSessions } from './work-sessions'

export function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: newId('bot'),
    name: 'Ana',
    slug: 'ana',
    label: 'Dev',
    systemPrompt: 'You write code.',
    providerId: null,
    model: null,
    effort: null,
    contextLimit: null,
    maxOutputTokens: null,
    avatar: { shape: 'square', color: 'blue', eyes: 'capsule' },
    linuxUid: 2001,
    displayNum: 1,
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

type ToolHandler = (ctx: ToolExecContext, call: ToolCall) => Promise<ToolResult>

/** In-memory AgentEnvironment for agent-loop tests; every port has a no-op default a test may replace. */
export class TestEnv implements AgentEnvironment {
  bots = new Map<string, Bot>()
  conversations = new Map<string, ConversationSummary>()
  messages: Message[] = []
  statuses: Array<{
    botId: string
    status: BotStatus
    detail?: string
    targetBotId?: string
    sessionId?: string
    conversationId?: string
  }> = []
  /** Conversation id → work session id (`workSession`). */
  sessions = new Map<string, string>()
  /** Work session id → where it started, for sessions that ended. */
  endedSessions = new Map<string, { originConversationId: string; title: string }>()
  deltas: Array<{ messageId: string; delta: string }> = []
  activity: BotActivityAction[] = []
  screens: Array<{ botId: string } & ScreenState> = []
  llmCalls: Array<LlmCallRecord & { id: string }> = []
  toolCalls = new Map<string, ToolCallStart & Partial<ToolCallFinish>>()
  toolLog: ToolCall[] = []
  settings: Record<string, unknown> = {}
  blobs = new MemoryBlobStore()
  hostState = settingsHostState(this)
  cli: Partial<Record<CliEngine, GuestCliBackend>> = {}
  confirmations: ConfirmationRequest[] = []
  logs: Array<{ level: string; message: string; extra?: Record<string, unknown> }> = []
  /** Provider of the group triage; when unset, triage uses the bot's own model. */
  triageProvider: LLMProvider | null = null
  /** Serves a view for every session of `sessions` (tests replace it for sessions of their own). */
  workSessions: AgentEnvironment['workSessions'] = new InMemoryWorkSessions((id) => this.sessionView(id))
  knowledge: KnowledgeContext = { catalog: () => '', forTurn: async () => '' }
  projects: ProjectDirectory = {
    resolve: () => ({ general: true }),
    block: () => '',
  }
  cliQuota: (providerId: string, engine: CliEngine, update: unknown) => void = () => undefined
  cliMcp: (bot: Bot, engine: CliEngine) => Promise<CliMcpConfig> = async () => ({
    servers: {},
    disallowedTools: [],
    fingerprint: '',
    tokensByServer: {},
  })
  mcpTools: (bot: Bot) => Promise<BotMcpToolSet> = async () => ({
    tools: [],
    index: new Map(),
    tokensByServer: {},
  })
  mcpServerName: (slug: string) => string | null = () => null
  /** No repositories (see `fakeRepoInstructions`). */
  repoInstructions: (bot: Bot, paths: string[], signal?: AbortSignal) => Promise<RepoInstructionFile[]> =
    async () => []
  providerExhausted: (providerId: string) => boolean = () => false
  resolveFallbackModel: (bot: Bot) => Promise<ResolvedModel | null> = async () => null
  resolveSummaryModel: (bot: Bot) => Promise<ResolvedModel> = (bot) => this.resolveModel(bot)
  resolveModelRequest: AgentEnvironment['resolveModelRequest'] = (): ModelRequestResult => ({
    ok: false,
    error: 'Choosing a model is not available here.',
  })
  /** Every tool family on and no catalog. */
  skillContext: (bot: Bot, lane: string) => SkillContext = () => ({
    catalog: '',
    families: new Set(TOOL_FAMILY_NAMES),
  })
  userLanguage: () => Language = () => 'en'
  turnFinished: (info: TurnFinishedInfo) => void = () => undefined
  toolInputDraft: (ctx: ToolInputDraftContext, toolName: string, partialJson: string) => void = () =>
    undefined
  activePlan: (bot: Bot, laneKey: string, conversationId: string | null) => ActivePlan | null = () => null
  /** Bot id → its open sessions and plans (`workState`). */
  workStates = new Map<string, BotWorkState>()
  workState: (botId: string) => BotWorkState = (botId) =>
    this.workStates.get(botId) ?? { sessions: [], plans: [] }
  setAside: InMemorySetAside = new InMemorySetAside(() => this.now())
  private time = 1_000
  memory: InMemoryMemory = new InMemoryMemory(
    () => this.messages,
    (botId, conversationId) => this.conversations.get(conversationId)?.memberBotIds.includes(botId) ?? false,
    () => this.now(),
  )

  constructor(
    public provider: LLMProvider,
    public toolHandler: ToolHandler = async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  ) {}

  log(level: string, message: string, extra?: Record<string, unknown>): void {
    this.logs.push({ level, message, ...(extra ? { extra } : {}) })
  }

  private sessionView(sessionId: string) {
    const conversationId = [...this.sessions].find(([, id]) => id === sessionId)?.[0]
    const conversation = conversationId ? this.conversations.get(conversationId) : undefined
    if (!conversation) return null
    return {
      id: sessionId,
      botId: conversation.memberBotIds[0] ?? '',
      conversationId: conversation.id,
      title: conversation.title ?? 'Work session',
      goal: '',
      cwd: '/workspace',
      projectId: conversation.projectId,
      planId: null,
      repoName: null,
      branch: null,
      brief: '',
    }
  }

  private addConversation(
    type: ConversationSummary['type'],
    memberBotIds: string[],
    extra: Partial<ConversationSummary> = {},
  ): ConversationSummary {
    const conversation: ConversationSummary = {
      id: newId('conversation'),
      type,
      title: null,
      settings: {},
      projectId: null,
      createdAt: 1,
      updatedAt: 1,
      lastMessageAt: null,
      memberBotIds,
      lastMessage: null,
      sidebar: { sectionId: null, order: 0, pinned: false, hidden: false, unreadCount: 0 },
      ...extra,
    }
    this.conversations.set(conversation.id, conversation)
    return conversation
  }

  addBot(bot: Bot): ConversationSummary {
    this.bots.set(bot.id, bot)
    return this.addConversation('direct', [bot.id])
  }

  addGroup(
    botIds: string[],
    settings: ConversationSummary['settings'] = {},
    title = 'Group',
  ): ConversationSummary {
    return this.addConversation('group', botIds, { settings, title })
  }

  requestConfirmation(input: ConfirmationRequest): void {
    this.confirmations.push(input)
  }

  internalConversation(fromBotId: string, toBotId: string): ConversationSummary {
    const existing = [...this.conversations.values()].find(
      (c) => c.type === 'internal' && c.memberBotIds.includes(fromBotId) && c.memberBotIds.includes(toBotId),
    )
    return existing ?? this.addConversation('internal', [fromBotId, toBotId])
  }

  async resolveTriageModel(candidates: Bot[]): Promise<ResolvedModel> {
    if (!this.triageProvider) return this.resolveModel(candidates[0] as Bot)
    return { kind: 'native', provider: this.triageProvider, providerId: 'prv_triage', model: 'cheap' }
  }

  userMessage(conversationId: string, content: string): Message {
    const message: Message = {
      id: newId('message'),
      conversationId,
      authorType: 'user',
      authorBotId: null,
      kind: 'text',
      content,
      payload: null,
      createdAt: this.now(),
    }
    this.messages.push(message)
    return message
  }

  /** The "Routine: <name>" card a routine run posts (its content is what the bot reads). */
  routineRun(conversationId: string, botId: string, instructions: string, routineId = 'rtn_1'): Message {
    return this.appendMessage({
      conversationId,
      authorType: 'system',
      kind: 'card',
      content: instructions,
      payload: {
        type: 'routine_run',
        routineId,
        botId,
        name: 'Report',
        prompt: instructions.split('\n').at(-1) ?? '',
        late: false,
        manual: false,
      },
    })
  }

  now(): number {
    return (this.time += 5)
  }

  /** Moves the fake clock forward. */
  advance(ms: number): void {
    this.time += ms
  }

  listBots(): Bot[] {
    return [...this.bots.values()]
  }

  getBot(id: string): Bot | null {
    return this.bots.get(id) ?? null
  }

  workSession(conversationId: string): ReturnType<AgentEnvironment['workSession']> {
    const sessionId = this.sessions.get(conversationId)
    if (!sessionId) return null
    const ended = this.endedSessions.get(sessionId)
    return ended ? { sessionId, ended } : { sessionId }
  }

  getConversation(id: string): ConversationSummary | null {
    return this.conversations.get(id) ?? null
  }

  findDirectConversation(botId: string): ConversationSummary | null {
    return (
      [...this.conversations.values()].find((c) => c.type === 'direct' && c.memberBotIds.includes(botId)) ??
      null
    )
  }

  recentMessages(conversationId: string, limit: number): Message[] {
    return this.messages.filter((m) => m.conversationId === conversationId).slice(-limit)
  }

  getSetting<T>(key: string, fallback: T): T {
    return (this.settings[key] as T) ?? fallback
  }

  setSetting(key: string, value: unknown): void {
    this.settings[key] = value
  }

  setBotStatus(
    botId: string,
    status: BotStatus,
    detail?: string,
    targetBotId?: string,
    sessionId?: string,
    conversationId?: string,
  ): void {
    this.statuses.push({
      botId,
      status,
      ...(detail ? { detail } : {}),
      ...(targetBotId ? { targetBotId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(conversationId ? { conversationId } : {}),
    })
  }

  appendMessage(input: Parameters<AgentEnvironment['appendMessage']>[0]): Message {
    const message: Message = {
      id: newId('message'),
      conversationId: input.conversationId,
      authorType: input.authorType,
      authorBotId: input.authorBotId ?? null,
      kind: input.kind,
      content: input.content,
      payload: input.payload,
      createdAt: this.now(),
    }
    this.messages.push(message)
    return message
  }

  updateMessage(id: string, patch: Parameters<AgentEnvironment['updateMessage']>[1]): Message {
    const message = this.messages.find((m) => m.id === id)
    if (!message) throw new Error(`no message ${id}`)
    if (patch.content !== undefined) message.content = patch.content
    if (patch.payload !== undefined) message.payload = structuredClone(patch.payload)
    return message
  }

  deleteMessage(id: string): void {
    this.messages = this.messages.filter((m) => m.id !== id)
  }

  emitDelta(_conversationId: string, messageId: string, delta: string): void {
    this.deltas.push({ messageId, delta })
  }

  emitActivity(action: BotActivityAction): void {
    this.activity.push(action)
  }

  emitScreen(botId: string, screen: ScreenState): void {
    this.screens.push({ botId, ...screen })
  }

  recordLlmCall(record: LlmCallRecord): string {
    const id = newId('llmCall')
    this.llmCalls.push({ ...record, id })
    this.llmCallWrites.push({ ...record, id })
    return id
  }

  /** Every write of a call, inserts and updates, in order (`llmCalls` keeps each call's latest). */
  llmCallWrites: Array<LlmCallRecord & { id: string }> = []

  updateLlmCall(id: string, record: LlmCallRecord): void {
    const index = this.llmCalls.findIndex((c) => c.id === id)
    if (index < 0) throw new Error(`no LLM call ${id}`)
    this.llmCalls[index] = { ...record, id }
    this.llmCallWrites.push({ ...record, id })
  }

  startToolCall(record: ToolCallStart): void {
    this.toolCalls.set(record.id, { ...record })
  }

  finishToolCall(id: string, finish: ToolCallFinish): void {
    const current = this.toolCalls.get(id)
    if (current) this.toolCalls.set(id, { ...current, ...finish })
  }

  async resolveModel(
    _bot?: Bot,
    _options?: Parameters<AgentEnvironment['resolveModel']>[1],
  ): Promise<ResolvedModel> {
    return { kind: 'native', provider: this.provider, providerId: 'prv_test', model: 'fake-model' }
  }

  async executeTool(ctx: ToolExecContext, call: ToolCall): Promise<ToolResult> {
    this.toolLog.push(call)
    return this.toolHandler(ctx, call)
  }
}

/** Tool handler that answers `computer` screenshots with a fresh PNG blob. */
export function screenshotTools(env: TestEnv): ToolHandler {
  let n = 0
  return async (_ctx, call) => {
    if (call.name === 'computer') {
      const png = solidPng(4, 4, [n++ % 255, 0, 0])
      const sha = await env.blobs.put(png)
      return {
        content: [
          { type: 'text', text: 'screen' },
          { type: 'image', sha256: sha, mediaType: 'image/png', width: 4, height: 4 },
        ],
        screenshotSha: sha,
      }
    }
    return { content: [{ type: 'text', text: `ran ${call.name}` }] }
  }
}

/** A TestEnv whose ports `overrides` replaces. */
export function createTestEnv(
  provider: LLMProvider,
  overrides: Partial<AgentEnvironment> & { toolHandler?: ToolHandler } = {},
): TestEnv {
  return Object.assign(new TestEnv(provider), overrides)
}
