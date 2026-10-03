import { randomUUID } from 'node:crypto'

import { CODEX_HOME } from '@milibot/shared'

import type { CliLaunch, CliOneShot, CliOneShotResult, CliTurnIO, CliTurnResult } from '../cli/engine'
import { exitMessage } from '../cli/guest-process'
import { laneProcLabel, oneShotProcLabel } from '../cli/lane'
import { laneKeyOf, type LaneProcess, LaneSessions } from '../cli/lane-pool'
import { TurnInterrupt } from '../cli/process'
import { type CliStartup, emptyStartup } from '../cli/startup'
import { addTokens } from '../cli/usage'
import { cliCatalogPrices } from '../llm/pricing'
import { EMPTY_TOKENS, type TokenUsage, usageWithCost } from '../llm/usage'
import { MILIBOT_MCP_SERVER } from '../mcp/names'
import { CODEX_PROC_LABEL, codexErrorCode } from './config'
import { CODEX_TOOLS, codexFileDiffs, unwrapShellCommand } from './items'
import type {
  CodexErrorInfo,
  ServerNotification,
  ServerRequest,
  ThreadItem,
  ThreadStartResponse,
  TokenUsageBreakdown,
  Turn,
  UserInput,
} from './protocol'
import { CodexRpc, CodexRpcError, type RpcItem, type ServerRequestHandler } from './rpc'

class Session implements LaneProcess {
  threadId: string | null = null
  model: string | null = null

  constructor(
    readonly rpc: CodexRpc,
    readonly signature: string,
  ) {}

  get alive(): boolean {
    return this.rpc.alive
  }

  close(force?: boolean): Promise<void> {
    return this.rpc.close(force)
  }
}

const DEFAULT_MODEL_NAME = 'codex-default'
const MAX_LOGGED_EVENTS = 500
/** A thread that no longer exists (deleted, other machine): start over with the memory recap. */
const MISSING_THREAD = /no rollout found|thread.*not found/i
/** Notifications left out of the turn's event log (the completed item or the diff store carries them). */
const STREAMED = new Set([
  'item/agentMessage/delta',
  'item/commandExecution/outputDelta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
  'item/fileChange/patchUpdated',
  'turn/diff/updated',
])

/**
 * Codex features Milibot replaces with its own tools (sub-agents, goals, pictures, skills), and CLAUDE.md read
 * like AGENTS.md (the first of the two in each folder, see `CLI_ENGINE_INFO.instructionFiles`).
 */
const BASE_CONFIG: Record<string, unknown> = {
  'features.multi_agent': false,
  'features.goals': false,
  'features.image_generation': false,
  'skills.include_instructions': false,
  project_doc_fallback_filenames: ['CLAUDE.md'],
}

const text = (value: string): UserInput => ({ type: 'text', text: value, text_elements: [] })

/** Codex counts cached prompt tokens inside `inputTokens` and reasoning inside `outputTokens`. */
function codexTokens(u: TokenUsageBreakdown): TokenUsage {
  return {
    inputTokens: Math.max(0, u.inputTokens - u.cachedInputTokens - u.cacheWriteInputTokens),
    cachedReadTokens: u.cachedInputTokens,
    cacheWriteTokens: u.cacheWriteInputTokens,
    outputTokens: Math.max(0, u.outputTokens - u.reasoningOutputTokens),
    reasoningTokens: u.reasoningOutputTokens,
  }
}

/**
 * The CLI reports no cost: calls are priced from OpenAI's table (with a ChatGPT plan, what the API would
 * have charged).
 */
function codexBilling(usage: TokenUsage | null, model: string | null) {
  return { usage: usageWithCost(usage ?? EMPTY_TOKENS, null, cliCatalogPrices('codex', model)) }
}

/**
 * Requests Milibot cannot let the model make (it runs unattended; questions and approvals go through
 * Milibot's own tools): approvals are granted, the rest refused so the turn goes on.
 */
export const answerServerRequest: ServerRequestHandler = (request: ServerRequest) => {
  switch (request.method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { result: { decision: 'accept' } }
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { result: { decision: 'approved' } }
    case 'mcpServer/elicitation/request':
      return { result: { action: 'decline', content: null } }
    default:
      return { error: { code: -32601, message: `${request.method} is not available in Milibot` } }
  }
}

function errorText(err: unknown): string {
  return err instanceof CodexRpcError ? err.rpc.message : (err as Error).message
}

function mcpOutput(item: Extract<ThreadItem, { type: 'mcpToolCall' }>): string {
  if (item.error) return item.error.message
  return (item.result?.content ?? [])
    .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
    .filter(Boolean)
    .join('\n')
}

/** One long-lived `codex app-server` process per active bot lane, each with one thread (resumed after idling). */
export class CodexSessions extends LaneSessions<Session> {
  /** Thread config of a lane: provider, Milibot's MCP server (by env token), external servers, switches. */
  async threadConfig(launch: CliLaunch): Promise<Record<string, unknown>> {
    const { url } = await this.backend.mcpEndpoint(launch.bot.id, laneKeyOf(launch))
    const effort = launch.tuning?.effort
    const contextLimit = launch.tuning?.contextLimit
    return {
      ...launch.providerConfig,
      ...BASE_CONFIG,
      ...(effort ? { model_reasoning_effort: effort } : {}),
      ...(contextLimit ? { model_auto_compact_token_limit: contextLimit } : {}),
      [`mcp_servers.${MILIBOT_MCP_SERVER}`]: {
        url,
        bearer_token_env_var: 'MILIBOT_MCP_TOKEN',
        // Unattended: Milibot's tools never wait for an approval. Outside "code mode" the model sees them
        // upfront (GPT-6 models would otherwise only find them by searching).
        default_tools_approval_mode: 'approve',
        omit_tools_from: ['code_mode'],
        startup_timeout_sec: 30,
        // ask_bot blocks until the other bot answers (bounded by bots.ask_timeout_seconds).
        tool_timeout_sec: 3600,
      },
      ...Object.fromEntries(
        Object.entries(launch.externalMcp?.servers ?? {}).map(([slug, server]) => [
          `mcp_servers.${slug}`,
          server,
        ]),
      ),
    }
  }

  private async ensure(
    launch: CliLaunch,
    config: Record<string, unknown>,
  ): Promise<{ session: Session; launched: CliTurnResult['launched'] }> {
    const key = laneKeyOf(launch)
    const signature = JSON.stringify([
      launch.env,
      config,
      launch.cwd ?? null,
      launch.instructions,
      launch.readOnly === true,
    ])
    let session = this.lane(key)
    if (session && (!session.alive || session.signature !== signature)) {
      await this.close(key)
      session = undefined
    }
    if (session?.threadId) return { session, launched: null }
    if (!session) {
      const { token } = await this.backend.mcpEndpoint(launch.bot.id, key)
      const rpc = await CodexRpc.start(
        this.backend,
        {
          user: 'agent',
          argv: ['codex', 'app-server'],
          cwd: launch.cwd ?? '/workspace',
          env: {
            ...launch.env,
            CODEX_HOME,
            MILIBOT_MCP_TOKEN: token,
            MILIBOT_BOT: launch.bot.slug,
          },
          display: launch.bot.displayNum,
          label: laneProcLabel(CODEX_PROC_LABEL, launch.bot, key),
          bot: launch.bot.slug,
        },
        answerServerRequest,
        (message, extra) => this.log(message, { laneKey: key, ...extra }),
        this.timing.killGraceMs,
      )
      session = new Session(rpc, signature)
      this.addLane(key, session)
      try {
        await rpc.initialize()
      } catch (err) {
        await this.close(key)
        throw err
      }
    }
    const params = {
      cwd: launch.cwd ?? '/workspace',
      approvalPolicy: 'never',
      sandbox: launch.readOnly ? 'read-only' : 'danger-full-access',
      config,
    }
    const withAppendix = (startup: CliStartup) =>
      startup.systemAppendix ? `${launch.instructions}\n\n${startup.systemAppendix}` : launch.instructions
    const stored = this.backend.getSessionId(key)
    if (stored) {
      const startup = launch.startup?.(false) ?? emptyStartup()
      try {
        const resumed = await session.rpc.request<ThreadStartResponse>('thread/resume', {
          ...params,
          threadId: stored,
          excludeTurns: true,
          developerInstructions: withAppendix(startup),
          ...(launch.model ? { model: launch.model } : {}),
        })
        session.threadId = resumed.thread.id
        session.model = resumed.model
        return { session, launched: { fresh: false, startup } }
      } catch (err) {
        if (!MISSING_THREAD.test(errorText(err))) throw err
        this.log('codex thread not found; starting a fresh one', { laneKey: key })
        this.backend.setSessionId(key, null)
      }
    }
    const startup = launch.startup?.(true) ?? emptyStartup()
    const started = await session.rpc.request<ThreadStartResponse>('thread/start', {
      ...params,
      developerInstructions: withAppendix(startup),
      ...(launch.model ? { model: launch.model } : {}),
    })
    session.threadId = started.thread.id
    session.model = started.model
    this.backend.setSessionId(key, started.thread.id)
    return { session, launched: { fresh: true, startup } }
  }

  async runTurn(launch: CliLaunch, input: string, io: CliTurnIO): Promise<CliTurnResult> {
    const key = laneKeyOf(launch)
    const events: unknown[] = []
    let launched: CliTurnResult['launched'] = null
    let threadId = this.backend.getSessionId(key)
    let model = launch.model
    let request: Record<string, unknown> = {}
    let usage: TokenUsage = { ...EMPTY_TOKENS }
    let requests = 0
    let firstContextTokens: number | null = null
    let lastContextTokens: number | null = null
    let contextWindow: number | null = null
    let reply = ''
    let stop: TurnInterrupt | null = null
    const done = (outcome: {
      ok: boolean
      text: string
      durationMs: number | null
      subtype: string
      error: string | null
      errorInfo?: CodexErrorInfo | null
    }): CliTurnResult => {
      const errorInfo = outcome.errorInfo ?? null
      return {
        launched,
        ok: outcome.ok,
        text: outcome.text,
        sessionId: threadId,
        model: model ?? DEFAULT_MODEL_NAME,
        usage,
        billing: codexBilling(usage, model),
        requests,
        firstContextTokens,
        lastContextTokens,
        durationMs: outcome.durationMs,
        subtype: outcome.subtype,
        error: outcome.error
          ? { code: codexErrorCode(errorInfo, outcome.error), message: outcome.error }
          : null,
        request,
        details: { contextWindow, errorInfo },
        events,
      }
    }
    const failed = (subtype: string, error: string | null) =>
      stop?.interrupted
        ? done({ ok: false, text: reply, durationMs: null, subtype: 'interrupted', error: null })
        : done({ ok: false, text: reply, durationMs: null, subtype, error })

    let session: Session
    try {
      const config = await this.threadConfig(launch)
      request = { config: redactConfig(config) }
      const ensured = await this.ensure(launch, config)
      session = ensured.session
      launched = ensured.launched
    } catch (err) {
      return failed('error', errorText(err))
    }
    threadId = session.threadId
    model = session.model ?? launch.model
    this.laneBusy(key)
    const thread = session.threadId as string
    const rpc = session.rpc

    const prefix = launched?.startup.inputPrefix
    const payload = prefix ? `${prefix}\n\n---\n\n${input}` : input
    let turnId: string | null = null
    let durationMs = 0
    let open = true
    let lastError: { message: string; info: CodexErrorInfo | null } | null = null
    const messages = new Map<string, string>()
    /** Messages sent mid-turn Codex has not taken in yet (by client id), and ones it refused to steer. */
    const sent = new Map<string, string>()
    const unsent: string[] = []

    const startTurn = async (value: string): Promise<string> => {
      const started = await rpc.request<{ turn: Turn }>('turn/start', {
        threadId: thread,
        input: [text(value)],
        ...(launch.model ? { model: launch.model } : {}),
        ...(launch.tuning?.effort ? { effort: launch.tuning.effort } : {}),
      })
      return started.turn.id
    }
    const sendInterrupt = () => {
      if (turnId) void rpc.request('turn/interrupt', { threadId: thread, turnId }).catch(() => undefined)
    }
    const interrupt = new TurnInterrupt(io.signal, sendInterrupt, this.timing.interruptGraceMs)
    stop = interrupt
    const started = Date.now()
    try {
      turnId = await startTurn(payload)
      if (interrupt.interrupted) sendInterrupt()
      io.onAcceptingInput?.((extra) => {
        if (!open || interrupt.interrupted || !rpc.alive) return false
        const clientId = randomUUID()
        sent.set(clientId, extra)
        const expectedTurnId = turnId as string
        void rpc
          .request('turn/steer', {
            threadId: thread,
            expectedTurnId,
            input: [text(extra)],
            clientUserMessageId: clientId,
          })
          .catch(() => {
            // The turn ended (or cannot take input) meanwhile: it goes in a follow-up turn.
            if (sent.delete(clientId)) unsent.push(extra)
          })
        return true
      })
      for (;;) {
        const item: RpcItem = await rpc.items.next(interrupt.deadline)
        if (item.type === 'exit') {
          io.onTextBoundary(null)
          await this.close(key)
          return failed('process_exited', exitMessage('codex', item))
        }
        const message = item.message
        if (!STREAMED.has(message.method) && events.length < MAX_LOGGED_EVENTS) events.push(message)
        const completed = this.handle(message, thread, turnId, io, {
          messages,
          sent,
          onText: (delta) => (reply += delta),
          onUsage: (last, window) => {
            usage = addTokens(usage, codexTokens(last))
            requests++
            firstContextTokens ??= last.inputTokens
            lastContextTokens = last.inputTokens
            contextWindow = window ?? contextWindow
            io.onProgress?.({ requests, model, billing: codexBilling(usage, model), lastContextTokens })
          },
          onError: (message, info) => (lastError = { message, info }),
        })
        if (!completed) continue
        durationMs += completed.durationMs ?? 0
        const leftover = [...unsent, ...(completed.status === 'completed' ? sent.values() : [])]
        unsent.length = 0
        sent.clear()
        if (leftover.length && completed.status === 'completed' && !interrupt.interrupted) {
          // Messages that arrived as the turn ended: answered in a follow-up turn, still this Milibot turn.
          turnId = await startTurn(leftover.join('\n\n'))
          for (let i = 0; i < leftover.length; i++) io.onInputTaken?.()
          continue
        }
        open = false
        io.onTextBoundary(null)
        const error = completed.status === 'failed' ? (completed.error ?? lastError) : null
        return done({
          ok: completed.status === 'completed' && !interrupt.interrupted,
          text: [...messages.values()].at(-1) ?? reply,
          durationMs: durationMs || Date.now() - started,
          subtype: interrupt.interrupted ? 'interrupted' : completed.status,
          error: error ? error.message : null,
          errorInfo: error?.info ?? null,
        })
      }
    } catch (err) {
      await this.close(key, interrupt.deadline.aborted)
      return failed('error', errorText(err))
    } finally {
      open = false
      interrupt.dispose()
      this.laneIdle(key, session, launch.idleTimeoutMs)
    }
  }

  /** One notification of a running turn; returns the turn once it completed. */
  private handle(
    message: ServerNotification,
    threadId: string,
    turnId: string | null,
    io: CliTurnIO,
    state: {
      messages: Map<string, string>
      sent: Map<string, string>
      onText(delta: string): void
      onUsage(last: TokenUsageBreakdown, window: number | null): void
      onError(message: string, info: CodexErrorInfo | null): void
    },
  ): {
    status: Turn['status']
    durationMs: number | null
    error: { message: string; info: CodexErrorInfo | null } | null
  } | null {
    const params = (message.params ?? {}) as { threadId?: string; turnId?: string }
    if (message.method === 'account/rateLimits/updated') {
      io.onQuota?.((message.params as { rateLimits: unknown }).rateLimits)
      return null
    }
    if (params.threadId !== undefined && params.threadId !== threadId) return null
    if (params.turnId !== undefined && turnId !== null && params.turnId !== turnId) return null
    switch (message.method) {
      case 'mcpServer/startupStatus/updated': {
        const p = message.params as { name: string; status: string; error: string | null }
        if (p.name === MILIBOT_MCP_SERVER && p.status === 'failed') io.onMcpStatus?.(false, p.error)
        return null
      }
      case 'item/agentMessage/delta': {
        const delta = (message.params as { delta: string }).delta
        state.onText(delta)
        io.onTextDelta(delta)
        return null
      }
      case 'thread/tokenUsage/updated': {
        const p = message.params as {
          tokenUsage: { last: TokenUsageBreakdown; modelContextWindow: number | null }
        }
        state.onUsage(p.tokenUsage.last, p.tokenUsage.modelContextWindow)
        return null
      }
      case 'error': {
        const p = message.params as {
          error: { message: string; codexErrorInfo: CodexErrorInfo | null }
          willRetry: boolean
        }
        if (!p.willRetry) state.onError(p.error.message, p.error.codexErrorInfo)
        return null
      }
      case 'item/started':
        this.itemStarted((message.params as { item: ThreadItem }).item, io, state.sent)
        return null
      case 'item/completed':
        this.itemCompleted((message.params as { item: ThreadItem }).item, io, state.messages)
        return null
      case 'turn/completed': {
        const turn = (message.params as { turn: Turn }).turn
        if (turnId !== null && turn.id !== turnId) return null
        return {
          status: turn.status,
          durationMs: turn.durationMs,
          error: turn.error ? { message: turn.error.message, info: turn.error.codexErrorInfo } : null,
        }
      }
      default:
        return null
    }
  }

  private itemStarted(item: ThreadItem, io: CliTurnIO, sent: Map<string, string>): void {
    switch (item.type) {
      case 'userMessage': {
        const clientId = (item as { clientId?: string | null }).clientId
        if (clientId && sent.delete(clientId)) io.onInputTaken?.()
        return
      }
      case 'agentMessage':
        io.onTextBoundary(null)
        return
      case 'commandExecution': {
        const c = item as Extract<ThreadItem, { type: 'commandExecution' }>
        io.onToolUse?.()
        io.onNativeToolStart(c.id, CODEX_TOOLS.exec, {
          command: unwrapShellCommand(c.command),
          actions: c.commandActions,
        })
        return
      }
      case 'fileChange': {
        const f = item as Extract<ThreadItem, { type: 'fileChange' }>
        io.onToolUse?.()
        io.onNativeToolStart(f.id, CODEX_TOOLS.patch, {
          files: f.changes.map((c) => ({ path: c.path, kind: c.kind.type })),
        })
        return
      }
      case 'webSearch':
        io.onToolUse?.()
        io.onNativeToolStart(item.id, CODEX_TOOLS.webSearch, { query: (item as { query: string }).query })
        return
      case 'imageView':
        io.onToolUse?.()
        io.onNativeToolStart(item.id, CODEX_TOOLS.viewImage, { path: (item as { path: string }).path })
        return
      case 'mcpToolCall': {
        const m = item as Extract<ThreadItem, { type: 'mcpToolCall' }>
        io.onToolUse?.()
        // Milibot's own tools reach the host through its MCP server; external ones are shown from here.
        if (m.server !== MILIBOT_MCP_SERVER)
          io.onNativeToolStart(m.id, `mcp__${m.server}__${m.tool}`, m.arguments)
        return
      }
      default:
        return
    }
  }

  private itemCompleted(item: ThreadItem, io: CliTurnIO, messages: Map<string, string>): void {
    switch (item.type) {
      case 'agentMessage': {
        const full = (item as { text: string }).text
        messages.set(item.id, full)
        io.onTextBoundary(full || null)
        return
      }
      case 'commandExecution': {
        const c = item as Extract<ThreadItem, { type: 'commandExecution' }>
        const isError = c.status !== 'completed' || (c.exitCode ?? 0) !== 0
        io.onNativeToolFinish(c.id, isError, c.aggregatedOutput ?? '', [])
        return
      }
      case 'fileChange': {
        const f = item as Extract<ThreadItem, { type: 'fileChange' }>
        const ok = f.status === 'completed'
        io.onNativeToolFinish(
          f.id,
          !ok,
          ok ? f.changes.map((c) => c.path).join('\n') : `patch ${f.status}`,
          ok ? codexFileDiffs(f.changes) : [],
        )
        return
      }
      case 'webSearch':
      case 'imageView':
        io.onNativeToolFinish(item.id, false, '', [])
        return
      case 'mcpToolCall': {
        const m = item as Extract<ThreadItem, { type: 'mcpToolCall' }>
        if (m.server !== MILIBOT_MCP_SERVER)
          io.onNativeToolFinish(m.id, m.status !== 'completed', mcpOutput(m), [])
        return
      }
      default:
        return
    }
  }

  /**
   * Single call without tools or history (summaries for Codex bots): an ephemeral thread in a process of its
   * own, stopped when the answer is complete.
   */
  async oneShot(request: CliOneShot): Promise<CliOneShotResult> {
    const result = (outcome: {
      text: string
      model: string | null
      usage: TokenUsage | null
      durationMs: number | null
      error: string | null
      errorInfo: CodexErrorInfo | null
    }): CliOneShotResult => ({
      text: outcome.text,
      model: outcome.model ?? DEFAULT_MODEL_NAME,
      usage: outcome.usage,
      billing: codexBilling(outcome.usage, outcome.model),
      durationMs: outcome.durationMs,
      error: outcome.error,
      request: {},
      details: { errorInfo: outcome.errorInfo },
    })
    const failed = (error: string, errorInfo: CodexErrorInfo | null = null) =>
      result({ text: '', model: request.model, usage: null, durationMs: null, error, errorInfo })
    let rpc: CodexRpc
    try {
      rpc = await CodexRpc.start(
        this.backend,
        {
          user: 'agent',
          argv: ['codex', 'app-server'],
          cwd: '/workspace',
          env: { ...request.env, CODEX_HOME },
          display: request.bot.displayNum,
          label: oneShotProcLabel(CODEX_PROC_LABEL, request.bot, request.label),
          bot: request.bot.slug,
        },
        answerServerRequest,
        this.log,
        this.timing.killGraceMs,
      )
    } catch (err) {
      return failed(errorText(err))
    }
    const signal = request.signal ?? new AbortController().signal
    const onAbort = () => void rpc.close()
    signal.addEventListener('abort', onAbort, { once: true })
    const started = Date.now()
    try {
      await rpc.initialize()
      const thread = await rpc.request<ThreadStartResponse>('thread/start', {
        cwd: '/workspace',
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ephemeral: true,
        developerInstructions: request.systemPrompt,
        ...(request.model ? { model: request.model } : {}),
        config: {
          ...request.providerConfig,
          ...BASE_CONFIG,
          'features.shell_tool': false,
          web_search: 'disabled',
          model_reasoning_effort: request.effort ?? 'low',
        },
      })
      const threadId = thread.thread.id
      const turn = await rpc.request<{ turn: Turn }>('turn/start', {
        threadId,
        input: [text(request.prompt)],
      })
      let usage: TokenUsage = { ...EMPTY_TOKENS }
      let answer = ''
      for (;;) {
        const item = await rpc.items.next(signal)
        if (item.type === 'exit') return failed(exitMessage('codex', item))
        const m = item.message
        const p = (m.params ?? {}) as { threadId?: string; turnId?: string }
        if (p.threadId !== threadId) continue
        if (m.method === 'item/agentMessage/delta') request.onText?.((m.params as { delta: string }).delta)
        else if (m.method === 'item/completed') {
          const it = (m.params as { item: ThreadItem }).item
          if (it.type === 'agentMessage') answer = (it as { text: string }).text
        } else if (m.method === 'thread/tokenUsage/updated')
          usage = addTokens(
            usage,
            codexTokens((m.params as { tokenUsage: { last: TokenUsageBreakdown } }).tokenUsage.last),
          )
        else if (m.method === 'turn/completed') {
          const completed = (m.params as { turn: Turn }).turn
          if (completed.id !== turn.turn.id) continue
          return result({
            text: completed.status === 'completed' ? answer : '',
            model: thread.model,
            usage,
            durationMs: completed.durationMs ?? Date.now() - started,
            error: completed.status === 'completed' ? null : (completed.error?.message ?? completed.status),
            errorInfo: completed.error?.codexErrorInfo ?? null,
          })
        }
      }
    } catch (err) {
      return failed(signal.aborted ? 'aborted' : errorText(err))
    } finally {
      signal.removeEventListener('abort', onAbort)
      await rpc.close()
    }
  }
}

/** The thread config as logged: header values of external servers (tokens) left out. */
function redactConfig(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => {
      if (!key.startsWith('mcp_servers.') || !value || typeof value !== 'object') return [key, value]
      const { http_headers: headers, env, ...rest } = value as Record<string, unknown>
      return [
        key,
        {
          ...rest,
          ...(headers ? { http_headers: '[redacted]' } : {}),
          ...(env ? { env: '[redacted]' } : {}),
        },
      ]
    }),
  )
}
