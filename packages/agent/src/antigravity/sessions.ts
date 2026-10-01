import { createHash } from 'node:crypto'

import { CLI_ENGINE_INFO, cliModelInfo, pickEffort, type ReasoningEffort } from '@milibot/shared'

import { AsyncQueue } from '../cli/async-queue'
import type {
  CliBilling,
  CliLaunch,
  CliOneShot,
  CliOneShotResult,
  CliTurnIO,
  CliTurnResult,
} from '../cli/engine'
import { exitMessage, GuestProcess, type GuestProcessExit } from '../cli/guest-process'
import { laneProcLabel, laneSuffix, oneShotProcLabel } from '../cli/lane'
import { laneKeyOf, type LaneProcess, LaneSessions } from '../cli/lane-pool'
import type { CliMcpConfig } from '../cli/mcp-config'
import { TurnInterrupt } from '../cli/process'
import { emptyStartup } from '../cli/startup'
import { addTokens } from '../cli/usage'
import { cliCatalogPrices } from '../llm/pricing'
import { EMPTY_TOKENS, type TokenUsage, usageWithCost } from '../llm/usage'
import { MILIBOT_MCP_SERVER } from '../mcp/names'
import { ANTIGRAVITY_PROC_LABEL, antigravityErrorCode } from './config'
import {
  ANTIGRAVITY_AGENTS_DIR,
  antigravityAgentFile,
  antigravityAgentName,
  antigravityToolsPrompt,
} from './profile'
import { type AntigravityEvent, antigravityInputLine, parseAntigravityLine } from './stream-json'
import { ANTIGRAVITY_LANE_TOOLS, antigravityMcpCall, antigravityToolCall } from './tools'

type QueueItem = AntigravityEvent | ({ type: 'exit' } & GuestProcessExit)
type InitEvent = Extract<AntigravityEvent, { type: 'init' }>

class Session implements LaneProcess {
  readonly queue = new AsyncQueue<QueueItem>()

  constructor(
    readonly proc: GuestProcess,
    readonly signature: string,
  ) {}

  get alive(): boolean {
    return this.proc.alive
  }

  close(force?: boolean): Promise<void> {
    return this.proc.close(force)
  }
}

const MAX_LOGGED_EVENTS = 500
/** Env var naming the lane's MCP bridge config (read by Milibot's bridge, which `agy` starts with its env). */
const MCP_CONFIG_ENV = 'MILIBOT_MCP_CONFIG'

/** Sent through `onQuota` after each turn: `agy` streams no quota, so the daemon reads `/usage` (throttled). */
export const ANTIGRAVITY_QUOTA_CHECK = { check: 'antigravity-usage' } as const

/** `gemini-3.8-flash-low` (how `agy` reports a model with its effort) → `gemini-3.8-flash`. */
export function antigravityBaseModel(model: string | null): string | null {
  if (!model || cliModelInfo('antigravity', model)) return model
  const base = model.replace(/-(?:low|medium|high|max)$/, '')
  return cliModelInfo('antigravity', base) ? base : model
}

/** agy's own level for a model named without one (it refuses `--model` alone when the model has levels). */
const DEFAULT_EFFORT = 'high'

/**
 * The `--effort` of a request: narrowed to the model's levels, `high` (agy's default) when none was asked for a
 * named model, none for a model without levels.
 */
export function antigravityEffort(
  model: string | null,
  effort: ReasoningEffort | null | undefined,
): string | null {
  const info = cliModelInfo('antigravity', model)
  if (info && !info.efforts.length) return null
  return pickEffort(effort ?? (model ? DEFAULT_EFFORT : null), info?.efforts)
}

/** `agy` reports no cost: calls are priced from the catalog (with a plan, what the API would have charged). */
function antigravityBilling(usage: TokenUsage | null, model: string | null): CliBilling {
  const priced = antigravityBaseModel(model) ?? CLI_ENGINE_INFO.antigravity.defaultModel
  return { usage: usageWithCost(usage ?? EMPTY_TOKENS, null, cliCatalogPrices('antigravity', priced)) }
}

const sha8 = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 8)

/** The external servers as the process gets them (none: null, so the process signature stays the same). */
function externalOf(launch: CliLaunch): CliMcpConfig['servers'] | null {
  const external = launch.externalMcp
  return external && Object.keys(external.servers).length ? external.servers : null
}

/**
 * One long-lived `agy -p` process per active bot lane in stream-json (one input per user line, a `result`
 * closing each), resumed with `--conversation <id>` after idling. Milibot's rules and persona are the lane's
 * agent (`--agent`), MCP comes through Milibot's bridge (see `antigravityMcpCall`).
 */
export class AntigravitySessions extends LaneSessions<Session> {
  /** Writes the lane's agent and MCP bridge config; returns the agent name and the config path. */
  private async laneFiles(
    launch: CliLaunch,
    systemAppendix: string,
  ): Promise<{ agent: string; mcp: string }> {
    const key = laneKeyOf(launch)
    const agent = antigravityAgentName(launch.bot, key)
    const { url, token } = await this.backend.mcpEndpoint(launch.bot.id, key)
    const servers = {
      ...externalOf(launch),
      [MILIBOT_MCP_SERVER]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } },
    }
    const mcp = await this.backend.writeAgentFile(
      `mcp-agy-${launch.bot.slug}${laneSuffix(key)}.json`,
      JSON.stringify({ servers }),
    )
    const prompt = [
      launch.instructions,
      antigravityToolsPrompt(launch.mcpTools ?? [], externalOf(launch)),
      systemAppendix,
    ]
      .filter(Boolean)
      .join('\n\n')
    await this.backend.writeAgentFile(
      `${ANTIGRAVITY_AGENTS_DIR}/${agent}/agent.md`,
      antigravityAgentFile(agent, launch.nativeTools ?? ANTIGRAVITY_LANE_TOOLS, prompt),
    )
    return { agent, mcp }
  }

  private async ensure(launch: CliLaunch): Promise<{
    session: Session
    argv: string[]
    launched: CliTurnResult['launched']
    stored: string | null
  }> {
    const effort = antigravityEffort(launch.model, launch.tuning?.effort)
    const signature = JSON.stringify([
      launch.model,
      effort,
      launch.env,
      launch.instructions,
      launch.nativeTools ?? null,
      externalOf(launch),
      launch.mcpTools ?? [],
    ])
    const key = laneKeyOf(launch)
    const existing = this.lane(key)
    if (existing?.alive && existing.signature === signature)
      return { session: existing, argv: [], launched: null, stored: null }
    if (existing) await this.close(key)
    const stored = this.backend.getSessionId(key)
    const startup = launch.startup?.(!stored) ?? emptyStartup()
    const files = await this.laneFiles(launch, startup.systemAppendix)
    const argv = [
      'agy',
      '--agent',
      files.agent,
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
      // A user message starting with "/" is text for the bot, never one of agy's commands.
      '--disable-slash-commands',
      ...(launch.model ? ['--model', launch.model] : []),
      ...(effort ? ['--effort', effort] : []),
      ...(stored ? ['--conversation', stored] : []),
      '-p=',
    ]
    const proc = await GuestProcess.start(
      this.backend,
      {
        user: 'agent',
        argv,
        cwd: launch.cwd ?? '/workspace',
        env: { ...launch.env, [MCP_CONFIG_ENV]: files.mcp, MILIBOT_BOT: launch.bot.slug },
        display: launch.bot.displayNum,
        label: laneProcLabel(ANTIGRAVITY_PROC_LABEL, launch.bot, key),
        bot: launch.bot.slug,
      },
      { log: this.log, killGraceMs: this.timing.killGraceMs },
    )
    const session = new Session(proc, signature)
    this.addLane(key, session)
    proc.listen({
      line: (text) => {
        const parsed = parseAntigravityLine(text)
        if (parsed) session.queue.push(parsed)
      },
      exit: (exit) => {
        session.queue.push({ type: 'exit', ...exit })
        this.dropLane(key, session)
      },
    })
    return { session, argv, launched: { fresh: !stored, startup }, stored }
  }

  runTurn(launch: CliLaunch, input: string, io: CliTurnIO): Promise<CliTurnResult> {
    return this.turn(launch, input, io, false)
  }

  private async turn(
    launch: CliLaunch,
    input: string,
    io: CliTurnIO,
    retried: boolean,
  ): Promise<CliTurnResult> {
    const key = laneKeyOf(launch)
    const events: unknown[] = []
    const started = Date.now()
    let argv: string[] = []
    let launched: CliTurnResult['launched'] = null
    let sessionId = this.backend.getSessionId(key)
    let model: string | null = null
    let usage: TokenUsage = { ...EMPTY_TOKENS }
    let requests = 0
    let firstContextTokens: number | null = null
    let lastContextTokens: number | null = null
    let reply = ''
    let stop: TurnInterrupt | null = null
    const done = (
      outcome: Pick<CliTurnResult, 'ok' | 'text' | 'subtype'> & { error: string | null; measured: boolean },
    ): CliTurnResult => ({
      launched,
      ok: outcome.ok,
      text: outcome.text,
      sessionId,
      model: model ?? launch.model ?? CLI_ENGINE_INFO.antigravity.defaultModel,
      usage: outcome.measured ? usage : null,
      billing: antigravityBilling(outcome.measured ? usage : null, model ?? launch.model),
      requests,
      firstContextTokens,
      lastContextTokens,
      durationMs: outcome.measured ? Date.now() - started : null,
      subtype: outcome.subtype,
      error: outcome.error ? { code: antigravityErrorCode(outcome.error), message: outcome.error } : null,
      request: { argv },
      details: {},
      events,
    })
    const failed = (subtype: string, error: string | null): CliTurnResult =>
      done({
        ok: false,
        text: reply,
        subtype: stop?.interrupted ? 'interrupted' : subtype,
        error: stop?.interrupted ? null : error,
        measured: false,
      })
    let session: Session
    let stored: string | null
    try {
      const ensured = await this.ensure(launch)
      session = ensured.session
      argv = ensured.argv
      launched = ensured.launched
      stored = ensured.stored
    } catch (err) {
      this.log('antigravity process did not start', { laneKey: key, err: (err as Error).message })
      return failed('error', `agy did not start: ${(err as Error).message}`)
    }
    this.laneBusy(key)
    let open = true
    const interrupt = new TurnInterrupt(
      io.signal,
      () => void session.proc.signal('SIGINT').catch(() => undefined),
      this.timing.interruptGraceMs,
    )
    stop = interrupt
    try {
      if (launched) {
        // `init` arrives before agy reads its first input: a stored conversation it lost became a new one.
        const init = await this.initOf(session, interrupt.deadline, events)
        if (init.type === 'exit') return failed('process_exited', exitMessage('agy', init))
        if (stored && init.conversationId !== stored && !retried && !interrupt.interrupted) {
          this.log('antigravity conversation not found; starting a fresh one', { laneKey: key })
          interrupt.dispose()
          await this.rotate(key)
          return this.turn(launch, input, io, true)
        }
        this.backend.setSessionId(key, init.conversationId)
        sessionId = init.conversationId
        model = init.model
      }
      const prefix = launched?.startup.inputPrefix
      await session.proc.write(antigravityInputLine(prefix ? `${prefix}\n\n---\n\n${input}` : input))
      /** Results still owed: one per message written, the first one included. */
      let pending = 1
      let inputs = 0
      io.onAcceptingInput?.((extra) => {
        if (!open || interrupt.interrupted || !session.alive) return false
        pending++
        void session.proc.write(antigravityInputLine(extra)).catch(() => undefined)
        return true
      })
      let stepText = ''
      const startedTools = new Set<string>()
      const milibotCalls = new Set<string>()
      for (;;) {
        const item = await session.queue.next(interrupt.deadline)
        const streamed = item.type === 'step' && item.state === 'ACTIVE' && item.textDelta !== null
        if (!streamed && events.length < MAX_LOGGED_EVENTS) events.push(item)
        switch (item.type) {
          case 'step':
            if (item.stepType === 'user_input' && item.state === 'DONE') {
              if (++inputs > 1) io.onInputTaken?.()
            } else if (item.stepType === 'agent_response') {
              if (item.textDelta) {
                stepText += item.textDelta
                io.onTextDelta(item.textDelta)
              }
              if (item.state === 'ACTIVE') break
              if (item.usage) {
                usage = addTokens(usage, item.usage)
                requests++
                const context = item.usage.inputTokens + item.usage.cachedReadTokens
                firstContextTokens ??= context
                lastContextTokens = context
              }
              const text = stepText.trim()
              if (text) reply = text
              io.onTextBoundary(text || null)
              stepText = ''
            } else if (item.stepType === 'tool' && item.tool) {
              const id = `${sessionId ?? 'agy'}:${item.index}`
              if (!startedTools.has(id)) {
                startedTools.add(id)
                io.onToolUse?.()
                const mcp = antigravityMcpCall(item.tool)
                if (mcp?.milibot) milibotCalls.add(id)
                else if (mcp) io.onNativeToolStart(id, mcp.name, mcp.input)
                else {
                  const call = antigravityToolCall(item.tool)
                  io.onNativeToolStart(id, call.name, call.input)
                }
              }
              if (item.state !== 'ACTIVE' && !milibotCalls.has(id))
                io.onNativeToolFinish(id, item.state !== 'DONE', item.tool.output ?? '', [])
            }
            break
          case 'result': {
            if (item.conversationId) {
              this.backend.setSessionId(key, item.conversationId)
              sessionId = item.conversationId
            }
            if (--pending > 0 && item.ok && !interrupt.interrupted) break
            open = false
            io.onTextBoundary(null)
            io.onQuota?.(ANTIGRAVITY_QUOTA_CHECK)
            const ok = item.ok && !interrupt.interrupted
            return done({
              ok,
              text: reply || item.text.trim(),
              subtype: interrupt.interrupted ? 'interrupted' : item.status.toLowerCase(),
              error: ok || interrupt.interrupted ? null : item.error || item.status,
              measured: true,
            })
          }
          case 'exit':
            io.onTextBoundary(null)
            return failed('process_exited', exitMessage('agy', item))
          default:
            break
        }
      }
    } catch (err) {
      // Past the interrupt deadline the process ignored SIGINT: it is killed, not asked again.
      await this.close(key, interrupt.deadline.aborted)
      return failed('error', (err as Error).message)
    } finally {
      open = false
      interrupt.dispose()
      this.laneIdle(key, session, launch.idleTimeoutMs)
    }
  }

  /** The process's `init` (or its exit before one). */
  private async initOf(
    session: Session,
    deadline: AbortSignal,
    events: unknown[],
  ): Promise<InitEvent | Extract<QueueItem, { type: 'exit' }>> {
    for (;;) {
      const item = await session.queue.next(deadline)
      events.push(item)
      if (item.type === 'init' || item.type === 'exit') return item
    }
  }

  /**
   * Single `agy -p` call without tools or MCP (summaries, triage, drawing prompts for Antigravity bots): its
   * system prompt is an agent of its own (named by the prompt's hash, so concurrent calls never overwrite each
   * other's), the prompt goes through stdin.
   */
  async oneShot(request: CliOneShot): Promise<CliOneShotResult> {
    const purpose = request.label ?? 'summary'
    const agent = `milibot-${request.bot.slug}-${purpose}-${sha8(request.systemPrompt)}`
    const effort = antigravityEffort(request.model, request.effort ?? 'low')
    const argv = [
      'agy',
      '--agent',
      agent,
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--disable-slash-commands',
      ...(request.model ? ['--model', request.model] : []),
      ...(effort ? ['--effort', effort] : []),
      '-p=',
    ]
    const answer = (outcome: {
      text: string
      model: string | null
      usage: TokenUsage | null
      durationMs: number | null
      error: string | null
    }): CliOneShotResult => ({
      text: outcome.text,
      model: outcome.model ?? request.model ?? CLI_ENGINE_INFO.antigravity.defaultModel,
      usage: outcome.usage,
      billing: antigravityBilling(outcome.usage, outcome.model ?? request.model),
      durationMs: outcome.durationMs,
      error: outcome.error,
      request: { argv },
      details: {},
    })
    const failed = (error: string) => answer({ text: '', model: null, usage: null, durationMs: null, error })
    let proc: GuestProcess
    try {
      await this.backend.writeAgentFile(
        `${ANTIGRAVITY_AGENTS_DIR}/${agent}/agent.md`,
        antigravityAgentFile(agent, [], request.systemPrompt, { lane: false }),
      )
      proc = await GuestProcess.start(
        this.backend,
        {
          user: 'agent',
          argv,
          cwd: '/workspace',
          env: { ...request.env },
          display: request.bot.displayNum,
          label: oneShotProcLabel(ANTIGRAVITY_PROC_LABEL, request.bot, purpose),
          bot: request.bot.slug,
        },
        { log: this.log, killGraceMs: this.timing.killGraceMs },
      )
    } catch (err) {
      return failed((err as Error).message)
    }
    const signal = request.signal ?? new AbortController().signal
    const started = Date.now()
    let model: string | null = null
    let usage: TokenUsage = { ...EMPTY_TOKENS }
    let text = ''
    let result: Extract<AntigravityEvent, { type: 'result' }> | null = null
    const outcome = new Promise<CliOneShotResult>((resolve) => {
      const onAbort = () => {
        resolve(failed('aborted'))
        void proc.close()
      }
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
      proc.listen({
        line: (line) => {
          const event = parseAntigravityLine(line)
          if (event?.type === 'init') model = event.model
          else if (event?.type === 'result') result = event
          else if (event?.type === 'step' && event.stepType === 'agent_response') {
            if (event.textDelta) {
              text += event.textDelta
              request.onText?.(event.textDelta)
            }
            if (event.usage) usage = addTokens(usage, event.usage)
          }
        },
        exit: (exit) => {
          signal.removeEventListener('abort', onAbort)
          const last = result as Extract<AntigravityEvent, { type: 'result' }> | null
          if (!last) return resolve(failed(exitMessage('agy', exit)))
          resolve(
            answer({
              text: last.ok ? (last.text || text).trim() : '',
              model,
              usage,
              durationMs: Date.now() - started,
              error: last.ok ? null : last.error || last.status,
            }),
          )
        },
      })
    })
    try {
      await proc.write(antigravityInputLine(request.prompt), true)
    } catch (err) {
      void proc.close()
      throw err
    }
    return outcome
  }
}
