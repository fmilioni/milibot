import {
  type AgentEnvironment,
  type ChatSink,
  type CliPort,
  type LlmCallRecord,
  type ModelResolver,
  type RepoInstructionsPort,
  settingsHostState,
  type SkillContext,
  type Telemetry,
  type ToolGateway,
  type WorkPort,
  type WorkspaceReader,
} from '@milibot/agent'
import { CLI_ENGINE_DRIVERS, type GuestCliBackend } from '@milibot/agent/cli'
import type { Bot, CliEngine, Language, LogFn, ModelChoice, WorkspaceEvent } from '@milibot/shared'

import type { AttachmentService } from '../attachments'
import type { FileBlobStore } from '../blobs'
import type { DesignService } from '../design'
import type { GroupService } from '../groups'
import type { KnowledgeService } from '../knowledge'
import type { McpService } from '../mcp'
import type { McpToolServer } from '../mcp-server'
import type { MemoryStore } from '../memory'
import type { MessageWriter } from '../messages'
import type { ToolCallStore } from '../observability'
import type { PlanService } from '../plans'
import type { ProjectService } from '../projects'
import {
  type CliPlanTracker,
  type ModelCatalog,
  type ModelPolicy,
  resolveBotModelRequest,
} from '../providers'
import type { RoutineService } from '../routines'
import { languageOf, type WorkSessionService } from '../sessions'
import type { SettingsService } from '../settings'
import type { TaskCardService } from '../tasks'
import type { WorkspaceStore } from '../workspace-store'
import type { ToolRegistry } from './tool-registry'

/** Which model runs each piece of work: the lane's (a work session's `model_spec`), else the bot's own. */
export function createModelResolver(deps: {
  catalog: ModelCatalog
  settings: Pick<SettingsService, 'withBotEnv' | 'fallbackModel' | 'providerExhausted'>
  models: ModelPolicy
  modelOfLane: (laneKey: string | undefined) => ModelChoice | null
}): ModelResolver {
  const { catalog, settings, models } = deps
  return {
    resolveModel: async (bot, options) => {
      const choice = options?.model ?? deps.modelOfLane(options?.laneKey)
      const resolved = choice ? await catalog.resolveChoice(choice) : null
      return settings.withBotEnv(
        resolved && resolved.kind !== 'unavailable' ? resolved : await catalog.resolve(bot),
        bot,
      )
    },
    resolveSummaryModel: (bot) => models.summaryModel(bot),
    resolveTriageModel: (candidates) => models.triageModel(candidates),
    resolveFallbackModel: (bot) => settings.fallbackModel(bot),
    resolveModelRequest: (bot, request, laneKey) =>
      resolveBotModelRequest(catalog, bot, request, deps.modelOfLane(laneKey)),
    providerExhausted: (providerId) => settings.providerExhausted(providerId),
  }
}

export interface AgentEnvDeps {
  now: () => number
  store: WorkspaceStore
  emit: (event: WorkspaceEvent) => void
  messages: MessageWriter
  recordLlmCall: (record: LlmCallRecord) => string
  updateLlmCall: (id: string, record: LlmCallRecord) => void
  toolCalls: ToolCallStore
  blobs: FileBlobStore
  memory: MemoryStore
  models: ModelResolver
  cliPlans: CliPlanTracker
  designs: DesignService
  skillContext: (bot: Bot) => SkillContext
  workSessions: WorkSessionService
  planService: PlanService
  attachments: AttachmentService
  routines: RoutineService
  taskCards: TaskCardService
  knowledge: KnowledgeService
  projects: ProjectService
  groups: GroupService
  externalMcp: McpService
  mcp: McpToolServer
  tools: ToolRegistry
  cli: Partial<Record<CliEngine, GuestCliBackend>>
  repoInstructions: RepoInstructionsPort['repoInstructions']
  userLanguage: () => Language
  /** Replaces secret values (workspace secrets, MCP credentials) in anything stored or sent to the app. */
  redact: <T>(value: T) => T
  log: LogFn
}

/** What `@milibot/agent` sees of the workspace, one port at a time (see `AgentEnvironment`). */
export function createAgentEnvironment(deps: AgentEnvDeps): AgentEnvironment {
  const { now, store, emit, messages, toolCalls, workSessions, redact } = deps

  const reader: WorkspaceReader = {
    now,
    listBots: () => store.bots.list(),
    getBot: (id) => store.bots.find(id),
    getConversation: (id) => {
      try {
        return store.conversations.get(id)
      } catch {
        return null
      }
    },
    findDirectConversation: (botId) => store.conversations.findDirect(botId),
    recentMessages: (conversationId, limit) => store.messages.list(conversationId, { limit }).messages,
    getSetting: (key, fallback) => store.settings.get(key, fallback),
    userLanguage: () => deps.userLanguage(),
  }

  const chat: ChatSink = {
    setBotStatus: (botId, status, detail, targetBotId, sessionId, conversationId) => {
      try {
        store.bots.setStatus(botId, status)
      } catch {
        return
      }
      emit({
        type: 'bot.status',
        payload: {
          botId,
          status,
          ...(detail ? { detail } : {}),
          ...(targetBotId ? { targetBotId } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(conversationId ? { conversationId } : {}),
        },
      })
    },
    appendMessage: (message) => messages.append(message),
    updateMessage: (id, patch) => messages.update(id, patch),
    deleteMessage: (id) => messages.delete(id),
    emitDelta: (conversationId, messageId, delta) => messages.emitDelta(conversationId, messageId, delta),
    emitActivity: (action) =>
      emit({ type: 'bot.activity', payload: { botId: action.botId, action: redact(action) } }),
    internalConversation: (fromBotId, toBotId) => {
      const { conversation, created } = store.conversations.internal(fromBotId, toBotId)
      if (created) emit({ type: 'conversation.created', payload: { conversation } })
      return conversation
    },
    requestConfirmation: ({ botId, conversationId, action, params, reason, data }) => {
      const bot = store.bots.find(botId)
      if (!bot) return
      deps.groups.requestConfirmation({
        bot,
        conversationId,
        action,
        params: { ...params, botId: params.botId ?? '', botName: params.botName ?? '' },
        reason,
        data,
      })
    },
  }

  const telemetry: Telemetry = {
    recordLlmCall: (record) => deps.recordLlmCall(record),
    updateLlmCall: (id, record) => deps.updateLlmCall(id, record),
    startToolCall: (record) => {
      toolCalls.start({ ...record, arguments: redact(record.arguments) })
      deps.taskCards.onToolStarted(record)
      workSessions.onToolStarted(record)
    },
    finishToolCall: (id, finish) => {
      const { diffs, ...rest } = finish
      toolCalls.finish(id, { ...rest, result: redact(rest.result), error: redact(rest.error) })
      if (diffs?.length) {
        const files = diffs.map((d) => {
          const language = languageOf(d.path)
          return { ...redact(d), ...(language ? { language } : {}) }
        })
        toolCalls.saveDiff(id, files, finish.finishedAt)
      }
      deps.taskCards.onToolFinished(id, finish)
      workSessions.onToolFinished(id)
    },
    turnFinished: ({ routineId, ...info }) => {
      workSessions.turnFinished(info)
      deps.designs.drafts.turnEnded(info.turnId)
      if (info.reply.includes('/workspace/')) void deps.attachments.attachMentionedImages(info)
      const routine = routineId ? deps.routines.list().find((r) => r.id === routineId) : undefined
      emit({
        type: 'turn.finished',
        payload: { ...info, routine: routine ? { id: routine.id, name: routine.name } : null },
      })
    },
    log: deps.log,
  }

  const tools: ToolGateway = {
    executeTool: (ctx, call) => deps.tools.execute(ctx, call),
    skillContext: (bot) => deps.skillContext(bot),
    mcpTools: (bot) => deps.externalMcp.toolSet(bot),
    mcpServerName: (slug) => deps.externalMcp.serverName(slug),
    toolInputDraft: (ctx, toolName, partialJson) => {
      if (toolName === 'design_write_frame') deps.designs.drafts.update(ctx, partialJson)
    },
  }

  const cli: CliPort = {
    cli: deps.cli,
    cliMcp: async (bot, engine) =>
      deps.externalMcp.cliConfig(bot, engine, await deps.mcp.proxyEndpointFor(bot.id, engine)),
    cliQuota: (providerId, engine, update) => {
      const merged = CLI_ENGINE_DRIVERS[engine].mergeQuota(
        deps.cliPlans.usage(providerId),
        providerId,
        update,
        deps.now(),
      )
      if (!merged) return
      const { providerId: _id, plan, updatedAt: _at, ...info } = merged
      deps.cliPlans.recordRateLimit(providerId, info, plan)
    },
  }

  const work: WorkPort = {
    workSession: (conversationId) => workSessions.forConversation(conversationId),
    workSessions: workSessions.directory(),
    activePlan: (bot, laneKey, conversationId) => deps.planService.activePlan(bot, laneKey, conversationId),
  }

  return {
    ...reader,
    ...chat,
    ...telemetry,
    ...deps.models,
    ...tools,
    ...cli,
    ...work,
    repoInstructions: deps.repoInstructions,
    hostState: settingsHostState({
      getSetting: (key, fallback) => store.settings.get(key, fallback),
      setSetting: (key, value) => store.settings.set(key, value),
    }),
    blobs: deps.blobs,
    memory: deps.memory,
    knowledge: {
      catalog: (bot) => deps.knowledge.catalog(bot),
      forTurn: (bot, query, signal, projectId) =>
        deps.knowledge.forTurn(bot, query, signal, projectId ?? null),
    },
    projects: {
      resolve: (ref) => deps.projects.resolve(ref),
      block: (bot, projectId, options) => deps.projects.block(bot, projectId, options),
    },
  }
}
