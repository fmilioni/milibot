import { join } from 'node:path'

import type { AgentHost, LlmCallRecord, SkillContext } from '@milibot/agent'
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingSetting,
  type LocalEmbeddingLevel,
  type ModelDownloadProgress,
} from '@milibot/agent/embeddings'
import type { ImageGenerate } from '@milibot/agent/images'
import type { LLMProvider } from '@milibot/agent/llm'
import { SETTING_FAMILIES, type SettingFamily } from '@milibot/agent/tools'
import {
  type Bot,
  CLI_ENGINES,
  type CliEngine,
  type CloseBehavior,
  type LogFn,
  type WorkspaceEvent,
} from '@milibot/shared'

import type { Db } from '../../db/sqlite'
import { DaemonError, errorMessage } from '../../errors'
import { findQemuImg } from '../../host/info'
import type { VmShutdownMode } from '../../ipc/protocol'
import type { SecretStore } from '../../secrets/secret-store'
import { startOfLocalDay } from '../../util/time'
import { SETUP_VM_PENDING_KEY } from '../../workspace-db/setup-keys'
import { AttachmentService } from '../attachments'
import { BackupService } from '../backup'
import { FileBlobStore } from '../blobs'
import { BoardRoutes, BoardService, BoardTools } from '../boards'
import { BotService, PromptVersionService, TeamTools } from '../bots'
import { BrowserService, BrowserTools } from '../browser'
import { CodeTools } from '../code'
import { ComputerTools } from '../computer'
import { ConversationService, SidebarRoutes } from '../conversations'
import { CredentialService, resolveSecretRefs } from '../credentials'
import {
  ChromeDesignRenderer,
  defaultDesignAssets,
  type DesignAssets,
  type DesignRenderBackend,
  DesignService,
  DesignTools,
  type FontFetch,
} from '../design'
import { EmbeddingService, fakeEmbeddingFactory, recordEmbeddingCost } from '../embeddings'
import { GroupService } from '../groups'
import { ImageService, ImageTools } from '../images'
import { knowledgeCorpus, KnowledgeService, KnowledgeStore, KnowledgeTools } from '../knowledge'
import { McpService, McpTools } from '../mcp'
import { McpToolServer } from '../mcp-server'
import { MemoryRoutes, MemoryStore } from '../memory'
import { MessageWriter } from '../messages'
import {
  BlobReferences,
  CostStore,
  DebugRetention,
  DebugStore,
  LlmCallStore,
  ObservabilityRoutes,
  ToolCallStore,
} from '../observability'
import { PlanService, PlanTools } from '../plans'
import { ProcedureService } from '../procedures'
import { ProjectService, ProjectTools } from '../projects'
import {
  BotPromptRoutes,
  CLI_ENGINE_HOSTS,
  type CliBackend,
  CliEngineRoutes,
  type CliEngineRuntime,
  type CliImageJob,
  createCliBackend,
  createCliPlanTracker,
  createModelPolicy,
  forDrawing,
  ModelCatalog,
  modelRequests,
  ProviderClients,
  ProviderRoutes,
  ProviderStore,
} from '../providers'
import { RepoTools, WorktreeStore } from '../repos'
import { RoutineService, RoutineTools, routineVmGate } from '../routines'
import { mergeAllowedForLane, SessionTools, WorkSessionService } from '../sessions'
import { GitPolicySync, OfficeService, SettingsService } from '../settings'
import { SetupRoutes } from '../setup'
import { defaultBuiltinSkillsDir, SkillService, SkillTools } from '../skills'
import { SpendGuard, SpendRoutes } from '../spend'
import { TaskCardService, TaskCardTools } from '../tasks'
import { TodoStore } from '../todos'
import type { ToolProvider } from '../tools-core'
import { CliUsageRoutes, WorkspaceStatusService } from '../usage'
import { UserRequestService, UserRequestTools } from '../user-requests'
import {
  botLinuxUser,
  onVmTransition,
  VmAdmin,
  vmAdminSettings,
  type VmController,
  VmRoutes,
  VmStatsSampler,
  whenVmRunning,
} from '../vm'
import { WebService, WebTools } from '../web'
import { WorkspaceStore } from '../workspace-store'
import { createAgentEnvironment, createModelResolver } from './agent-env'
import { lazy } from './lazy'
import { type Component, Lifecycle } from './lifecycle'
import { collectHandlers } from './routes'
import { ToolRegistry } from './tool-registry'

interface EmbeddingOptions {
  /** The shared model cache (`<dataRoot>/models`); null: no local models. */
  modelsDir: string | null
  /** Local levels run in the supervisor's shared model processes (absent: a worker process of this one). */
  local?: (level: LocalEmbeddingLevel, onProgress: (p: ModelDownloadProgress) => void) => EmbeddingProvider
  /** Replaces every provider (`MILIBOT_FAKE_EMBEDDINGS=1`, tests). */
  create?: (
    setting: EmbeddingSetting,
    onProgress: (p: ModelDownloadProgress) => void,
  ) => Promise<EmbeddingProvider>
}

interface DesignOptions {
  /** Renders frames (default: a headless Chrome in the VM). */
  render?: (vm: VmController) => DesignRenderBackend
  /** Host the renderer's Chrome reaches this runtime at (default 10.0.2.2, the VM's view of the host). */
  urlHost?: string
  /** Google Fonts cache (default `<dataRoot>/fonts`, next to `workspaces/`). */
  fontsDir?: string | null
  fontFetch?: FontFetch
  imageFetch?: FontFetch
  assets?: DesignAssets | null
}

/** Replacements of the runtime's defaults: dev fakes chosen by the environment, and tests. */
export interface RuntimeOverrides {
  /** Every configured provider (tests). */
  llm?: LLMProvider
  /** Knowledge base embeddings; neither `modelsDir` nor `create`: deterministic fakes (no download). */
  embeddings?: EmbeddingOptions
  /** Built-in skills (default: found next to the code). */
  builtinSkillsDir?: string | null
  /** GitHub REST API base for skill imports (default `https://api.github.com`). */
  githubApi?: string
  design?: DesignOptions
  /** Image providers (`MILIBOT_FAKE_IMAGES=1`). */
  imageGenerate?: ImageGenerate
}

export interface ContainerOptions {
  workspaceId: string
  workspaceDir: string
  /** Workspace name shown in the VM and in backups. */
  workspaceName: string
  db: Db
  emit: (event: WorkspaceEvent) => void
  now: () => number
  secrets: SecretStore
  vm: VmController
  host: AgentHost
  version: string
  /** `MILIBOT_FAKE_LLM`: every provider becomes this script's `FakeProvider`. */
  fakeScriptPath: string | null
  /** Boot the VM when the runtime starts (a VM left running is always adopted). */
  vmAutostart: () => boolean
  /** Bots may run as CLI engines in the VM: their backends, Milibot's MCP server and the engines' runtimes. */
  enableCliEngines: boolean
  /** The workspace's "on close" setting; null: no VM to manage. */
  closeBehavior: (() => CloseBehavior) | null
  log: LogFn
  overrides: RuntimeOverrides
}

/**
 * Builds the workspace runtime's services in dependency order. A service used before it is built is a
 * `lazy` reference (read only once the runtime runs); everything that starts or stops is a lifecycle
 * component, started in the order added and stopped in reverse.
 */
export function createContainer(options: ContainerOptions) {
  const { workspaceId, workspaceDir, db, emit, now, vm, host, log, overrides } = options
  const background = (what: string, promise: Promise<unknown>) =>
    void promise.catch((err: unknown) => log('warn', `${what} failed`, { err: errorMessage(err) }))

  const botsRef = lazy<BotService>('bots')
  const sessionsRef = lazy<WorkSessionService>('work sessions')
  const boardsRef = lazy<BoardService>('boards')
  const mcpRef = lazy<McpToolServer>('MCP tool server')
  const imagesRef = lazy<ImageService>('images')
  const cliBackendsRef = lazy<Partial<Record<CliEngine, CliBackend>>>('CLI backends')

  const store = new WorkspaceStore(db, now)
  const llmCalls = new LlmCallStore(db, now)
  const toolCalls = new ToolCallStore(db)
  const worktrees = new WorktreeStore(db, now)
  const memory = new MemoryStore(db, now, (message, extra) => log('warn', message, extra))
  const blobs = new FileBlobStore(join(workspaceDir, 'debug', 'blobs'))
  const stepLists = new TodoStore(db, now)
  const providers = new ProviderStore({ db, workspaceId, secrets: options.secrets, now })
  const providerClients = new ProviderClients({
    store: providers,
    fakeScriptPath: options.fakeScriptPath,
    override: overrides.llm ?? null,
  })
  const catalog = new ModelCatalog({ store: providers, clients: providerClients })

  // Secrets, messages and spend: what every service writes through.
  const externalMcp = new McpService({
    db,
    workspaceId,
    secrets: options.secrets,
    vm,
    blobs,
    emit,
    now,
    getBot: (id) => store.bots.find(id),
    version: options.version,
    log,
  })
  const credentials = new CredentialService({
    workspaceId,
    workspaceName: () => options.workspaceName,
    secrets: options.secrets,
    getSetting: (key, fallback) => store.settings.get(key, fallback),
    setSetting: (key, value) => store.settings.set(key, value),
    now,
    listBots: () => store.bots.list(),
    vm,
    fetch,
    // A bot with a CLI engine lane reads them as `agent` (its API lanes then cannot: one owner per bot).
    secretFileOwner: (bot) =>
      catalog.cliEngine(bot) !== null ||
      sessionsRef
        .get()
        .openModels(bot.id)
        .some((m) => catalog.cliEngine(bot, m) !== null)
        ? 'agent'
        : botLinuxUser(bot.slug),
    log,
  })
  const redact = <T>(value: T): T => credentials.redact(externalMcp.redact(value))
  const messages = new MessageWriter({ store, emit, redact, secretValues: () => credentials.secretValues() })
  const cardConversation = (bot: Bot, conversationId: string | null) =>
    store.conversations.forCard(bot, conversationId)
  const append = messages.append.bind(messages)
  const update = messages.update.bind(messages)
  const getMessage = messages.get.bind(messages)
  const workspaceStatus = new WorkspaceStatusService({ vm, settings: store.settings, llmCalls, emit, now })
  const cliPlans = createCliPlanTracker({ vm, store, providers, emit, now, log })
  const blobReferences = new BlobReferences()
  const settingsBag = {
    getSetting: <T>(key: string, fallback: T): T => store.settings.get(key, fallback),
    setSetting: (key: string, value: unknown) => store.settings.set(key, value),
  }
  const spend = new SpendGuard({
    ...settingsBag,
    now,
    todayCost: (at) => llmCalls.usageSince(startOfLocalDay(at)).costUsd,
    postCard: (content, payload) => {
      const bot = store.bots.first()
      const dm = bot ? store.conversations.findDirect(bot.id) : null
      if (dm) append({ conversationId: dm.id, authorType: 'system', kind: 'card', content, payload })
    },
    hold: (held) => host.hold(held),
    log,
  })
  const office: OfficeService = new OfficeService({
    ...settingsBag,
    vm,
    enabled: () => settings.preferences().legacyOffice,
    emit,
    log,
  })
  const gitPolicy: GitPolicySync = new GitPolicySync({
    vm,
    preferences: () => settings.preferences(),
    mergePrFolders: () => sessionsRef.get().mergePrFolders(),
    log,
  })
  const settings: SettingsService = new SettingsService({
    store,
    providers,
    catalog,
    vm,
    credentials,
    spend,
    office,
    gitPolicy,
    cliUsage: (providerId) => cliPlans.usage(providerId),
    now,
    log,
  })
  const vmAdmin = new VmAdmin({
    vm,
    ...vmAdminSettings(store.settings, vm),
    workingBots: () => store.bots.list().filter((b) => b.status !== 'idle').length,
    idle: () => host.idle(),
    now,
    changed: () => emit({ type: 'vm.status', payload: { vm: vm.info() } }),
    goldenRevisions: () => vm.goldenRevisions(),
    log,
  })
  const vmStats = new VmStatsSampler({ vm, bots: () => store.bots.list(), log })
  const retention = new DebugRetention({
    ...settingsBag,
    db,
    references: blobReferences,
    debugDir: join(workspaceDir, 'debug'),
    now,
    log,
  })
  const backups = new BackupService({
    ...settingsBag,
    db,
    workspaceDir,
    workspaceName: () => options.workspaceName,
    version: options.version,
    vm,
    vmPending: () => store.settings.get<boolean>(SETUP_VM_PENDING_KEY, false),
    emit,
    now,
    qemuImg: () => findQemuImg(),
    log,
  })
  const recordLlmCall = (record: LlmCallRecord): string => {
    const id = llmCalls.insert({
      ...record,
      request: redact(record.request),
      response: redact(record.response),
      error: redact(record.error),
    })
    workspaceStatus.changed()
    spend.afterLlmCall()
    return id
  }
  const substituteSecrets = (bot: Bot, typed: string): string => {
    const secrets = credentials.secretsFor(bot)
    return resolveSecretRefs(typed, (name) => secrets.find((s) => s.name === name)?.value)
  }
  const models = createModelResolver({
    catalog,
    settings,
    models: createModelPolicy(store, catalog),
    modelOfLane: (laneKey) => sessionsRef.get().modelOfLane(laneKey),
  })

  // The CLI engines' side of the runtime (the backends come with the MCP server, below).
  const cliEngines = Object.fromEntries(
    CLI_ENGINES.map((engine) => [
      engine,
      CLI_ENGINE_HOSTS[engine].createRuntime({
        vm,
        store,
        host,
        inUse: () => providers.hasType(engine),
        backend: () => (options.enableCliEngines ? (cliBackendsRef.get()[engine] ?? null) : null),
        lightModel: async (bot, providerId) =>
          settings.withBotEnv(await catalog.resolveWith(providerId, catalog.lightModel(providerId)), bot),
        log,
      }),
    ]),
  ) as Record<CliEngine, CliEngineRuntime>

  const procedures = new ProcedureService({
    db,
    store,
    vm,
    blobs,
    host,
    emit,
    appendMessage: append,
    now,
    log,
  })
  const skills = new SkillService({
    db,
    store,
    userDir: join(workspaceDir, 'skills'),
    builtinDir:
      overrides.builtinSkillsDir === undefined ? defaultBuiltinSkillsDir() : overrides.builtinSkillsDir,
    procedures,
    vm,
    emit,
    now,
    skillLoads: (since) => toolCalls.succeededCalls('skill_load', since),
    githubToken: () => credentials.github.load(),
    githubApi: overrides.githubApi,
    log,
  })
  const settingFamilyOn: Record<SettingFamily, () => boolean> = {
    web_search: () => credentials.webSearch.available(),
    image_generation: () => imagesRef.get().available(),
  }
  const skillContext = (bot: Bot): SkillContext => {
    const context = skills.skillContext(bot)
    const off = new Set<string>(SETTING_FAMILIES.filter((family) => !settingFamilyOn[family]()))
    if (off.size === 0) return context
    return { ...context, families: new Set([...context.families].filter((f) => !off.has(f))) }
  }
  const groups = new GroupService({
    store,
    emit,
    appendMessage: append,
    updateMessage: update,
    deleteBot: (botId) => botsRef.get().delete(botId),
    managesTeam: (bot) => skills.skillContext(bot).families.has('team'),
    now,
  })
  groups.onConfirmed('continue_bot_exchange', ({ data }) => {
    if (!host.resumeBotMessage(String(data.heldId)))
      throw new DaemonError(
        'conflict',
        'The held bot message is gone (the workspace restarted or a bot was deleted)',
      )
  })
  const prompts = new PromptVersionService({
    store,
    groups,
    emit,
    appendMessage: append,
    updateMessage: update,
    getMessage,
    now,
  })
  const bots = botsRef.set(
    new BotService({
      store,
      emit,
      vm,
      host,
      messages,
      prompts,
      toolCalls,
      newBotModel: () => settings.newBotModel(),
      provisioned: (bot) => credentials.botProvisioned(bot),
      forgetCredentials: (botId) => credentials.forgetBot(botId),
      log,
    }),
  )
  const routines = new RoutineService({
    db,
    store,
    host,
    emit,
    appendMessage: append,
    now,
    catchUp: () => settings.preferences().routinesCatchUp,
    held: () => spend.status().paused,
    vmGate: () => routineVmGate({ settings: store.settings, vm, closeBehavior: options.closeBehavior }),
    bootVm: () => background('vm start', vm.start()),
    log,
  })
  const taskCards = new TaskCardService({
    messages: store.messages,
    getBot: (id) => store.bots.find(id),
    directConversationId: (botId) => store.conversations.findDirect(botId)?.id ?? null,
    appendMessage: append,
    updateMessage: update,
    exec: async (bot, cmd, vars) =>
      vm.status().state === 'running'
        ? vm.runningGuest().exec({ user: botLinuxUser(bot.slug), cmd, env: vars, timeoutMs: 20_000 })
        : null,
    onPullRequest: (conversationId, payload) => boardsRef.get().linkPullRequest(conversationId, payload),
    log,
  })
  const attachments = new AttachmentService({
    store,
    vm,
    blobs,
    stagingDir: join(workspaceDir, 'uploads'),
    emit,
    getMessage,
    appendMessage: append,
    cardConversation,
    updateMessage: update,
    now,
    log,
  })
  const userRequests = new UserRequestService({
    store,
    host,
    credentials,
    appendMessage: append,
    updateMessage: update,
    getMessage,
    now,
    log,
  })

  const embeddingOptions = overrides.embeddings
  const knowledgeDocs = new KnowledgeStore(db, now)
  const embeddings = new EmbeddingService({
    chunks: knowledgeCorpus(knowledgeDocs),
    getSetting: (key, fallback) => store.settings.get(key, fallback),
    setSetting: (key, value) => store.settings.set(key, value),
    createProvider:
      embeddingOptions?.create ??
      (embeddingOptions?.modelsDir
        ? (setting, onProgress) =>
            createEmbeddingProvider(setting, {
              local: { cacheDir: embeddingOptions.modelsDir as string, onProgress },
              ...(embeddingOptions.local
                ? { createLocal: (level) => embeddingOptions.local!(level, onProgress) }
                : {}),
              resolveApi: (api) => providerClients.embeddingApiOptions(api.providerId, api.model),
            })
        : fakeEmbeddingFactory()),
    apiMaxInputTokens: (providerId, model) =>
      providers.embeddingModel(providerId, model)?.contextWindow ?? null,
    recordUsage: (setting, usage) => recordEmbeddingCost(recordLlmCall, setting, usage),
    now,
    log,
  })
  const knowledge = new KnowledgeService({
    docs: knowledgeDocs,
    store,
    projects: {
      exists: (projectId): boolean => projects.find(projectId) !== null,
      ofConversation: (conversationId): string | null => projects.current(conversationId)?.id ?? null,
    },
    workspaceDir,
    vm,
    host,
    providers,
    catalog,
    attachments,
    emit,
    embeddings,
    modelsDir: embeddingOptions?.modelsDir ?? null,
    legacyOffice: () => office.access(),
    now,
    log,
  })
  office.onReady(() => knowledge.legacyOfficeReady())
  const projects = new ProjectService({
    db,
    store,
    emit,
    appendMessage: append,
    now,
    knowledgeCatalog: (bot, projectId) => knowledge.projectCatalog(bot, projectId),
    projectNotes: (projectId) => memory.projectNotes(projectId).map((n) => n.content),
  })
  const designOptions = overrides.design ?? {}
  const boards = boardsRef.set(
    new BoardService({
      db,
      vm,
      blobs,
      embeddings,
      getBot: (id) => store.bots.find(id),
      linkTargets: {
        plan: () => plans.linkTargets(),
        session: () => sessionsRef.get().linkTargets(),
        design: () => designs.linkTargets(),
      },
      appendMessage: append,
      updateMessage: update,
      emit,
      sessionOfConversation: (conversationId) =>
        sessionsRef.get().forConversation(conversationId)?.sessionId ?? null,
      imageFetch: designOptions.imageFetch,
      now,
      log,
    }),
  )
  const boardTools = new BoardTools({
    boards,
    projects,
    getBot: (id) => store.bots.find(id),
    resolveBot: (ref) => store.bots.resolveRef(ref),
    cardConversation,
    now,
  })

  const browser = new BrowserService({ vm, log })
  const web = new WebService({
    vm,
    host,
    searchKey: () => credentials.webSearch.current(),
    reportSearch: (error) => credentials.webSearch.report(error),
    userLanguage: () => settings.userLanguage(),
    now,
    log,
  })
  const images = imagesRef.set(
    new ImageService({
      providers,
      preference: () => settings.preferences().imageModel,
      vm,
      blobs,
      cardConversation,
      appendMessage: append,
      updateMessage: update,
      recordLlmCall,
      generate: overrides.imageGenerate,
      ...(options.enableCliEngines
        ? {
            cliImages: (bot: Bot, providerId: string, engine: CliEngine, job: CliImageJob) => {
              const draw = cliEngines[engine].generateImages
              if (!draw) throw new DaemonError('validation_failed', `${engine} does not draw pictures`)
              return draw(bot, providerId, job)
            },
          }
        : {}),
      now,
      log,
    }),
  )
  const designs = new DesignService({
    db,
    vm,
    blobs,
    render: designOptions.render?.(vm) ?? new ChromeDesignRenderer({ vm, log }),
    renderBase: () => mcpRef.get().baseUrl(designOptions.urlHost),
    assets: designOptions.assets === undefined ? defaultDesignAssets() : designOptions.assets,
    fontsDir:
      designOptions.fontsDir === undefined ? join(workspaceDir, '..', '..', 'fonts') : designOptions.fontsDir,
    fontFetch: designOptions.fontFetch,
    imageFetch: designOptions.imageFetch,
    assertConversation: (conversationId) => void store.conversations.get(conversationId),
    appendMessage: append,
    updateMessage: update,
    emit,
    now,
    log,
    draw: {
      writeText: (request) => host.writeText(request),
      model: async (bot, laneKey) =>
        forDrawing(await models.resolveModel(bot, laneKey ? { laneKey } : undefined)),
    },
    redact,
  })
  const mcp = mcpRef.set(
    new McpToolServer({
      getBot: (id) => store.bots.find(id),
      runTool: (botId, call, laneKey) => host.runTool(botId, null, call, laneKey),
      enabledFamilies: (bot) => skillContext(bot).families,
      readOnlyLane: (laneKey) => host.isReadOnlyLane(laneKey),
      proxy: {
        tools: (botId, slug) => externalMcp.proxyTools(botId, slug),
        call: async (botId, slug, tool, args) => redact(await externalMcp.proxyCall(botId, slug, tool, args)),
      },
      render: (token, path, query) => designs.renderDocument(token, path, query),
      blobs,
      version: options.version,
      log,
    }),
  )
  const cliBackends = cliBackendsRef.set(
    options.enableCliEngines
      ? Object.fromEntries(
          CLI_ENGINES.map((engine) => {
            const prepare = cliEngines[engine].prepare
            return [
              engine,
              createCliBackend({ engine, vm, store, mcp, log, prepare: prepare && (() => prepare()) }),
            ]
          }),
        )
      : {},
  )

  // Plans run in work sessions, which read the plans back (`sessions` is lazy).
  /** Plans and work sessions decide which session folders may merge pull requests (`gh` wrapper policy). */
  const emitAndRefreshGitPolicy = (event: WorkspaceEvent) => {
    emit(event)
    if (event.type === 'plan.updated' || event.type.startsWith('work_session.')) gitPolicy.refresh()
  }
  const plans = new PlanService({
    db,
    store,
    todos: stepLists,
    host,
    embeddings,
    cardConversation,
    appendMessage: append,
    updateMessage: update,
    emit: emitAndRefreshGitPolicy,
    now,
    pullRequestNote: (plan) => settings.pullRequestNote(plan),
    sessions: () => {
      const sessions = sessionsRef.get()
      return {
        start: (plan) => sessions.startForPlan(plan),
        sessionOf: (laneKey) => sessions.sessionOfLane(laneKey),
        stepsChanged: (sessionId) => sessions.stepsChanged(sessionId),
      }
    },
    log,
  })
  const workSessions = sessionsRef.set(
    new WorkSessionService({
      db,
      store,
      todos: stepLists,
      worktrees,
      host,
      vm,
      projects,
      plans,
      toolCalls: (conversationId, limit) => toolCalls.list(conversationId, { limit }),
      conversationCost: (conversationId) => llmCalls.conversationCost(conversationId),
      revokeLane: (laneKey) => mcp.revokeLane(laneKey),
      botEnv: (bot) => credentials.botEnv(bot),
      pullRequestNote: (plan) => settings.pullRequestNote(plan ?? undefined),
      cards: boards,
      modelLanesChanged: () => void credentials.syncSecretFiles().catch(() => undefined),
      appendMessage: append,
      updateMessage: update,
      emit: emitAndRefreshGitPolicy,
      now,
      log,
    }),
  )
  blobReferences.register('attachments', () => attachments.referencedBlobs())
  blobReferences.register('procedures', () => procedures.referencedBlobs())
  blobReferences.register('designs', () => designs.referencedBlobs())
  blobReferences.register('boards', () => boards.referencedBlobs())
  blobReferences.register('generated images', () => store.messages.generatedImageBlobs())

  bots.onDeleting((botId) => {
    userRequests.botDeleted(botId)
    workSessions.botDeleted(botId)
    designs.artwork?.abortBot(botId)
  })
  bots.onDeleted((botId) => routines.botDeleted(botId))

  // Tools: each catalog tool has exactly one provider (checked here) or runs in the agent host.
  const laneDefaults = {
    botEnv: (bot: Bot) => credentials.botEnv(bot),
    defaultCwd: (ctx: { laneKey?: string }) => workSessions.cwdFor(ctx.laneKey),
  }
  const toolProviders: ToolProvider[] = [
    new CodeTools({
      vm,
      ...laneDefaults,
      laneEnv: (ctx): Record<string, string> =>
        mergeAllowedForLane(
          {
            sessionOfLane: (laneKey) => workSessions.sessionOfLane(laneKey),
            plan: (planId) => plans.get(planId),
            autoMergePrs: () => settings.preferences().autoMergePrs,
          },
          ctx.laneKey,
        )
          ? { MILIBOT_ALLOW_MERGE: '1' }
          : {},
      legacyOffice: () => office.access(),
    }),
    new ComputerTools({ vm, blobs, resolveSecretRefs: substituteSecrets }),
    new TeamTools({
      store,
      groups,
      prompts,
      createBot: async (input, creator) => bots.createFromTool(input, creator),
      updateBot: (id, patch) => bots.update(id, patch),
    }),
    new RepoTools({ vm, store, worktrees, botEnv: laneDefaults.botEnv }),
    new UserRequestTools({ requests: userRequests, credentials }),
    new SessionTools({
      sessions: workSessions,
      plans,
      projects,
      cardConversation,
      models: modelRequests(catalog),
      cards: boards,
    }),
    new PlanTools({
      plans,
      todos: stepLists,
      store,
      projects,
      cardConversation,
      models: modelRequests(catalog),
      cards: boards,
    }),
    new BrowserTools({ browser, resolveSecretRefs: substituteSecrets }),
    new WebTools({ web }),
    new KnowledgeTools({
      service: knowledge,
      botName: (id) => (id ? (store.bots.find(id)?.name ?? null) : null),
      projects,
    }),
    new TaskCardTools({ cards: taskCards }),
    new McpTools({ mcp: externalMcp }),
    new SkillTools({
      skills,
      store,
      vm,
      blobs,
      procedures,
      engine: (bot, laneKey) => catalog.cliEngine(bot, sessionsRef.get().modelOfLane(laneKey)),
      notes: (slug) => (slug === 'code-and-repos' ? settings.pullRequestNote() : null),
      appendMessage: append,
    }),
    new RoutineTools({ routines, store, appendMessage: append, now }),
    new ProjectTools({ projects }),
    new DesignTools({ designs, getBot: (id) => store.bots.find(id), cardConversation }),
    boardTools,
    attachments.tools,
    new ImageTools({ images }),
  ]
  const tools = new ToolRegistry(toolProviders, redact)

  const env = createAgentEnvironment({
    now,
    store,
    emit,
    messages,
    recordLlmCall,
    toolCalls,
    blobs,
    memory,
    models,
    cliPlans,
    designs,
    skillContext,
    workSessions,
    planService: plans,
    attachments,
    routines,
    taskCards,
    knowledge,
    projects,
    groups,
    externalMcp,
    mcp,
    tools,
    cli: cliBackends,
    userLanguage: () => settings.userLanguage(),
    redact,
    log,
  })

  // Routes: every endpoint under /w/ is served by exactly one route set.
  const conversations = new ConversationService({
    store,
    emit,
    host,
    attachments,
    userRequests,
    workSessions,
  })
  const handlers = collectHandlers(
    workspaceStatus.handlers(),
    conversations.handlers(),
    bots.handlers(),
    new SidebarRoutes({ store, emit, now }).handlers(),
    new VmRoutes({ vm, settings: store.settings, admin: vmAdmin, stats: vmStats, now, log }).handlers(),
    new ObservabilityRoutes({
      store,
      llmCalls,
      toolCalls,
      debug: new DebugStore(db, now),
      retention,
      blobs,
    }).handlers(),
    new SpendRoutes({ spend, costs: new CostStore(db, now), providers }).handlers(),
    credentials.handlers(),
    backups.handlers(),
    new MemoryRoutes({ store, memory }).handlers(),
    new CliUsageRoutes({ providers, plans: cliPlans }).handlers(),
    new ProviderRoutes({
      providers,
      clients: providerClients,
      vm,
      now,
      created: () => {
        bots.introduceFirstBot()
        for (const engine of Object.values(cliEngines)) engine.providersChanged?.()
      },
      updated: (providerId) => {
        cliPlans.forget(providerId)
        void cliPlans.refresh(providerId)
      },
    }).handlers(),
    new BotPromptRoutes({
      store,
      host,
      defaultModel: async () => {
        const choice = settings.newBotModel()
        if (!choice) return null
        const resolved = await catalog.resolveWith(choice.providerId, choice.model)
        return resolved.kind === 'unavailable' ? null : resolved
      },
      log,
    }).handlers(),
    new SetupRoutes({ store, vm, introduceFirstBot: () => bots.introduceFirstBot(), log }).handlers(),
    new CliEngineRoutes({ store, vm, runtimes: cliEngines, now, log }).handlers(),
    settings.handlers(),
    office.handlers(),
    groups.handlers(),
    prompts.handlers(),
    externalMcp.handlers(),
    procedures.handlers(),
    skills.handlers(),
    routines.handlers(),
    attachments.handlers(),
    knowledge.handlers(),
    userRequests.handlers(),
    projects.handlers(),
    plans.handlers(),
    workSessions.handlers(),
    designs.handlers(),
    new BoardRoutes({ boards, now }).handlers(),
  )

  let vmShutdown: VmShutdownMode = 'keep'
  const lifecycle = new Lifecycle((name, err) =>
    log('warn', 'stop failed', { component: name, err: errorMessage(err) }),
  )
  lifecycle.add(
    {
      name: 'vm',
      stop: async () => {
        if (vmShutdown !== 'keep') await vm.stop({ force: vmShutdown === 'force' }).catch(() => undefined)
        await vm.close()
      },
    },
    { name: 'browser', stop: () => browser.close() },
    { name: 'designs', stop: () => designs.close() },
    {
      name: 'mcp server',
      start: async () => {
        if (!options.enableCliEngines) return
        await mcp
          .listen()
          .then((port) => log('info', 'MCP tool server listening', { port }))
          .catch((err: unknown) => log('error', 'MCP server failed to start', { err: errorMessage(err) }))
      },
      stop: () => mcp.close(),
    },
    { name: 'procedures', start: () => procedures.start() },
    { name: 'skills', start: () => skills.start(), stop: () => skills.stop() },
    { name: 'external MCP', start: () => externalMcp.start(), stop: () => externalMcp.stop() },
    { name: 'credentials', start: () => credentials.start(), stop: () => credentials.stop() },
    { name: 'spend', start: () => spend.start(), stop: () => spend.stop() },
    { name: 'vm admin', stop: () => vmAdmin.close() },
    { name: 'vm stats', start: () => vmStats.start(), stop: () => vmStats.close() },
    { name: 'debug retention', start: () => retention.start(), stop: () => retention.stop() },
    { name: 'backups', start: () => backups.start(), stop: () => backups.stop() },
    { name: 'office', start: () => office.start(), stop: () => office.stop() },
    { name: 'git policy', start: () => gitPolicy.start(), stop: () => gitPolicy.stop() },
    { name: 'user requests', start: () => userRequests.start(), stop: () => userRequests.stop() },
    { name: 'work sessions', start: () => workSessions.start(), stop: () => workSessions.stop() },
    { name: 'plans', stop: () => plans.stop() },
    { name: 'agent host', start: () => host.start(env), stop: () => host.stop() },
    routinesComponent(routines, vm),
    { name: 'attachments', start: () => attachments.start(), stop: () => attachments.stop() },
    { name: 'knowledge', start: () => knowledge.start(), stop: () => knowledge.stop() },
    { name: 'boards', start: () => boards.start(), stop: () => boards.stop() },
    ...(options.enableCliEngines
      ? [cliSweepComponent(vm, Object.values(cliBackends)), ...Object.values(cliEngines)]
      : []),
    {
      name: 'autostart',
      start: () => {
        if (options.vmAutostart() || vm.processRunning()) background('vm start', vm.start())
        // After the autostart: a VM booting now is updated once it is up.
        vmAdmin.resumeSystemUpdate()
        if (providers.hasAny()) bots.introduceFirstBot()
      },
    },
  )

  return {
    store,
    handlers,
    providers,
    settings,
    vmAdmin,
    bots,
    workspaceStatus,
    attachments,
    userRequests,
    workSessions,
    plans,
    tools,
    boards,
    designs,
    externalMcp,
    knowledge,
    mcp,
    procedures,
    skills,
    start: () => lifecycle.start(),
    async stop(vm: VmShutdownMode): Promise<void> {
      vmShutdown = vm
      await lifecycle.stop()
    },
  }
}

export type Container = ReturnType<typeof createContainer>

/** Routines tick when the VM comes up (a routine waiting for it runs then). */
function routinesComponent(routines: RoutineService, vm: VmController): Component {
  let unsubscribe = () => {}
  return {
    name: 'routines',
    start: () => {
      routines.start()
      unsubscribe = whenVmRunning(vm, () => routines.tick())
    },
    stop: () => {
      unsubscribe()
      routines.stop()
    },
  }
}

/** Once the VM is up, each engine stops the processes a previous runtime left there. */
function cliSweepComponent(vm: VmController, backends: CliBackend[]): Component {
  let unsubscribe = () => {}
  return {
    name: 'CLI sweep',
    start: () => {
      unsubscribe = onVmTransition(vm, {
        up: () => {
          for (const backend of backends) void backend.sweepOrphans()
        },
      })
    },
    stop: () => unsubscribe(),
  }
}
