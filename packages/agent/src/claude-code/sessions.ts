import { cliModelInfo, pickEffort } from '@milibot/shared'

import { AsyncQueue } from '../cli/async-queue'
import type {
  CliBilling,
  CliLaunch,
  CliOneShot,
  CliOneShotResult,
  CliTuning,
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
import { anthropicPrices } from '../llm/pricing'
import { computeCostUsd, EMPTY_TOKENS, type TokenUsage } from '../llm/usage'
import { MILIBOT_MCP_SERVER, milibotToolName } from '../mcp/names'
import { CLAUDE_CODE_PROC_LABEL, claudeCodeErrorCode } from './config'
import {
  type ClaudeCodeEvent,
  type ClaudeModelUsage,
  modelUsageDelta,
  parseStreamJsonLine,
  userInputLine,
} from './stream-json'
import { claudeCodeFileDiff } from './tools'

type QueueItem = ClaudeCodeEvent | ({ type: 'exit' } & GuestProcessExit)

interface CumulativeReport {
  costUsd: number
  models: ClaudeModelUsage[]
}

type ResultEvent = Extract<ClaudeCodeEvent, { type: 'result' }>

class Session implements LaneProcess {
  readonly queue = new AsyncQueue<QueueItem>()
  /**
   * `total_cost_usd`/`modelUsage` of the last result: Claude Code reports them cumulatively (null until the
   * first result of the process, see `turnCost`).
   */
  reported: CumulativeReport | null = null

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

/**
 * Variables carrying a model choice's tuning into `claude -p`: effort, output cap and the context the
 * session may fill (auto-compaction window; the 1M window is turned off when the limit fits in 200k).
 */
export function claudeCodeTuningEnv(tuning: CliTuning): Record<string, string> {
  const env: Record<string, string> = {}
  if (tuning.effort) env.CLAUDE_CODE_EFFORT_LEVEL = tuning.effort
  if (tuning.maxOutputTokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(tuning.maxOutputTokens)
  if (tuning.contextLimit) {
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(tuning.contextLimit)
    if (tuning.contextLimit <= STANDARD_CONTEXT_WINDOW) env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1'
  }
  return env
}

const STANDARD_CONTEXT_WINDOW = 200_000
const DEFAULT_MODEL_NAME = 'claude-code-default'

const MISSING_SESSION = /no conversation found|session.*not found/i

const tokenTotal = (u: TokenUsage) =>
  u.inputTokens + u.cachedReadTokens + u.cacheWriteTokens + u.outputTokens + u.reasoningTokens

/**
 * Cost and per-model usage of one turn. `total_cost_usd` and `modelUsage` are cumulative: over
 * the turns of the process, and, when Claude Code restores the cost state of a resumed session
 * (it does so only for the last session saved for the working directory), over earlier processes
 * too. Later turns of a process subtract the previous report. The first one is taken as is unless
 * its tokens exceed the turn's own `usage` (a restored total): then the turn is priced from its
 * tokens with the public price table (cache writes at the 1-hour rate Claude Code uses).
 */
export function turnCost(
  result: ResultEvent,
  previous: CumulativeReport | null,
  mainModel: string | null,
): { costUsd: number | null; modelUsage: ClaudeModelUsage[] } {
  if (previous) {
    return {
      costUsd: result.costUsd === null ? null : Math.max(0, result.costUsd - previous.costUsd),
      modelUsage: modelUsageDelta(result.modelUsage, previous.models),
    }
  }
  const main =
    result.modelUsage.find((m) => m.model === mainModel) ??
    [...result.modelUsage].sort((a, b) => tokenTotal(b) - tokenTotal(a))[0]
  const turnTokens = tokenTotal(result.usage)
  if (!main || tokenTotal(main) <= turnTokens * 1.02 + 50) {
    return { costUsd: result.costUsd, modelUsage: result.modelUsage }
  }
  const costUsd = claudeCodeTokenCost(main.model, result.usage)
  return {
    costUsd,
    modelUsage: [{ ...result.usage, model: main.model, costUsd, webSearchRequests: 0 }],
  }
}

/**
 * What a running turn cost so far, priced from its requests' own usage (the result's `total_cost_usd`, which
 * replaces it, only comes at the end).
 */
function claudeCodeProgressBilling(usage: TokenUsage, model: string | null): CliBilling {
  const costUsd = model ? claudeCodeTokenCost(model, usage) : null
  return { usage: { ...usage, costUsd, costSource: costUsd === null ? 'unknown' : 'computed' } }
}

/** Public API price of `usage` for a Claude model, with 1-hour cache writes (2x input). */
function claudeCodeTokenCost(model: string, usage: TokenUsage): number | null {
  const prices = anthropicPrices(model)
  if (!prices) return null
  return computeCostUsd(usage, {
    ...prices,
    priceCacheWritePerMtokUsd: (prices.priceInputPerMtokUsd as number) * 2,
  })
}

function sumModelUsage(models: ClaudeModelUsage[]): TokenUsage {
  return models.reduce<TokenUsage>((sum, m) => addTokens(sum, m), { ...EMPTY_TOKENS })
}

/** `llm_calls` usage of a Claude Code call: summed over the models it reports, else its own usage. */
export function claudeCodeUsage(result: {
  usage: TokenUsage | null
  modelUsage: ClaudeModelUsage[]
  costUsd: number | null
}): CliBilling {
  const models = result.modelUsage
  return {
    usage: {
      ...(models.length ? sumModelUsage(models) : (result.usage ?? EMPTY_TOKENS)),
      costUsd: result.costUsd,
      costSource: result.costUsd === null ? 'unknown' : 'provider',
    },
    ...(models.length ? { models } : {}),
  }
}

const MAX_LOGGED_EVENTS = 500
/** Partial-message events left out of the turn's event log (the final `assistant` message carries them). */
const STREAMED_EVENTS = new Set<string>([
  'text_delta',
  'tool_input_start',
  'tool_input_delta',
  'tool_input_stop',
])

/** The external servers as the process gets them (none: no entry, so the process signature stays the same). */
function externalOf(launch: CliLaunch): Pick<CliMcpConfig, 'servers' | 'disallowedTools'> | null {
  const external = launch.externalMcp
  return external && Object.keys(external.servers).length
    ? { servers: external.servers, disallowedTools: external.disallowedTools }
    : null
}

/** One long-lived `claude -p` process per active bot lane, resumed with `--resume <session>` after idling. */
export class ClaudeCodeSessions extends LaneSessions<Session> {
  async buildArgv(launch: CliLaunch, systemAppendix = ''): Promise<string[]> {
    const key = laneKeyOf(launch)
    const external = externalOf(launch)
    const { url, token } = await this.backend.mcpEndpoint(launch.bot.id, key)
    const mcpConfig = {
      mcpServers: {
        ...external?.servers,
        [MILIBOT_MCP_SERVER]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } },
      },
    }
    const disallowed = external?.disallowedTools ?? []
    const configPath = await this.backend.writeAgentFile(
      `mcp-${launch.bot.slug}${laneSuffix(key)}.json`,
      JSON.stringify(mcpConfig),
    )
    // A file, not argv: every VM user can read a process's argv, and Linux caps one argument at 128 KB.
    const appendPath = await this.backend.writeAgentFile(
      `prompt-${launch.bot.slug}${laneSuffix(key)}.md`,
      systemAppendix ? `${launch.instructions}\n\n${systemAppendix}` : launch.instructions,
    )
    const sessionId = this.backend.getSessionId(key)
    return [
      'claude',
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--replay-user-messages',
      '--include-partial-messages',
      '--dangerously-skip-permissions',
      '--mcp-config',
      configPath,
      '--strict-mcp-config',
      ...(disallowed.length ? ['--disallowedTools', disallowed.join(',')] : []),
      ...(launch.nativeTools ? ['--tools', launch.nativeTools.join(',')] : []),
      ...(launch.systemPrompt ? ['--system-prompt', launch.systemPrompt] : []),
      '--append-system-prompt-file',
      appendPath,
      ...(sessionId ? ['--resume', sessionId] : []),
      ...(launch.model ? ['--model', launch.model] : []),
    ]
  }

  private async ensure(
    launch: CliLaunch,
  ): Promise<{ session: Session; argv: string[]; launched: CliTurnResult['launched'] }> {
    const env = { ...launch.env, ...claudeCodeTuningEnv(launch.tuning ?? {}) }
    const signature = JSON.stringify([
      launch.model,
      env,
      launch.instructions,
      launch.systemPrompt ?? null,
      launch.nativeTools ?? null,
      externalOf(launch),
    ])
    const key = laneKeyOf(launch)
    const existing = this.lane(key)
    if (existing?.alive && existing.signature === signature)
      return { session: existing, argv: [], launched: null }
    if (existing) await this.close(key)
    const fresh = !this.backend.getSessionId(key)
    const startup = launch.startup?.(fresh) ?? emptyStartup()
    const argv = await this.buildArgv(launch, startup.systemAppendix)
    const proc = await GuestProcess.start(
      this.backend,
      {
        user: 'agent',
        argv,
        cwd: launch.cwd ?? '/workspace',
        // The Milibot MCP tools are few: load them upfront instead of paying a ToolSearch round trip.
        env: {
          ...env,
          DISABLE_AUTOUPDATER: '1',
          ENABLE_TOOL_SEARCH: 'false',
          // ask_bot blocks until the other bot answers (bounded by bots.ask_timeout_seconds).
          MCP_TOOL_TIMEOUT: '3600000',
          MILIBOT_BOT: launch.bot.slug,
        },
        display: launch.bot.displayNum,
        label: laneProcLabel(CLAUDE_CODE_PROC_LABEL, launch.bot, key),
        bot: launch.bot.slug,
      },
      { log: this.log, killGraceMs: this.timing.killGraceMs },
    )
    const session = new Session(proc, signature)
    this.addLane(key, session)
    proc.listen({
      line: (text) => {
        const parsed = parseStreamJsonLine(text)
        if (parsed) session.queue.push(parsed)
      },
      exit: (exit) => {
        session.queue.push({ type: 'exit', ...exit })
        this.dropLane(key, session)
      },
    })
    return { session, argv, launched: { fresh, startup } }
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
    const requests = new Map<string, number | null>()
    /** Each request's usage as its messages report it, for the progress of the running turn. */
    const requestUsage = new Map<string, TokenUsage>()
    let argv: string[] = []
    let launched: CliTurnResult['launched'] = null
    let sessionId = this.backend.getSessionId(key)
    let model: string | null = null
    let rateLimited = false
    let text = ''
    let stop: TurnInterrupt | null = null
    const requestStats = () => {
      const sizes = [...requests.values()].filter((v): v is number => v !== null)
      return {
        requests: requests.size,
        firstContextTokens: sizes[0] ?? null,
        lastContextTokens: sizes.at(-1) ?? null,
      }
    }
    const done = (
      outcome: Pick<CliTurnResult, 'ok' | 'text' | 'usage' | 'durationMs' | 'subtype'> & {
        error: string | null
        costUsd: number | null
        modelUsage: ClaudeModelUsage[]
      },
    ): CliTurnResult => ({
      launched,
      ok: outcome.ok,
      text: outcome.text,
      sessionId,
      model: model ?? outcome.modelUsage[0]?.model ?? launch.model ?? DEFAULT_MODEL_NAME,
      usage: outcome.usage,
      billing: claudeCodeUsage(outcome),
      ...requestStats(),
      durationMs: outcome.durationMs,
      subtype: outcome.subtype,
      error: outcome.error
        ? { code: claudeCodeErrorCode(outcome.error, rateLimited), message: outcome.error }
        : null,
      request: { argv },
      details: {},
      events,
    })
    const failed = (subtype: string, error: string | null): CliTurnResult =>
      done({
        ok: false,
        text,
        usage: null,
        durationMs: null,
        subtype: stop?.interrupted ? 'interrupted' : subtype,
        error: stop?.interrupted ? null : error,
        costUsd: null,
        modelUsage: [],
      })
    let session: Session
    try {
      const ensured = await this.ensure(launch)
      session = ensured.session
      argv = ensured.argv
      launched = ensured.launched
    } catch (err) {
      this.log('claude-code process did not start', { laneKey: key, err: (err as Error).message })
      return failed('error', `claude did not start: ${(err as Error).message}`)
    }
    this.laneBusy(key)
    const prefix = launched?.startup.inputPrefix
    const payload = prefix ? `${prefix}\n\n---\n\n${input}` : input
    let initialized = false
    let open = true
    let inputEchoed = false
    /** Messages sent mid-turn the CLI has not taken in yet: the turn goes on until it has. */
    const sent: string[] = []
    /** Usage and duration of the replies this turn already finished (to answer messages sent after them). */
    const earlier = { usage: { ...EMPTY_TOKENS }, durationMs: 0 }
    const toolInputs = new Map<number, { id: string; name: string; json: string }>()
    const nativeCalls = new Map<string, { name: string; input: unknown }>()
    const interrupt = new TurnInterrupt(
      io.signal,
      () => void session.proc.signal('SIGINT').catch(() => undefined),
      this.timing.interruptGraceMs,
    )
    stop = interrupt
    try {
      await session.proc.write(userInputLine(payload))
      io.onAcceptingInput?.((extra) => {
        if (!open || interrupt.interrupted || !session.alive) return false
        sent.push(extra)
        void session.proc.write(userInputLine(extra)).catch(() => undefined)
        return true
      })
      for (;;) {
        const item = await session.queue.next(interrupt.deadline)
        if (!STREAMED_EVENTS.has(item.type) && events.length < MAX_LOGGED_EVENTS) events.push(item)
        switch (item.type) {
          case 'init':
            initialized = true
            this.backend.setSessionId(key, item.sessionId)
            sessionId = item.sessionId
            model = item.model
            io.onMcpStatus?.(
              item.mcpServers.some((s) => s.name === MILIBOT_MCP_SERVER && s.status === 'connected'),
              null,
            )
            break
          case 'message_start':
            toolInputs.clear()
            io.onTextBoundary(null)
            break
          case 'tool_input_start':
            toolInputs.set(item.index, { id: item.id, name: item.name, json: '' })
            break
          case 'tool_input_delta': {
            const partial = toolInputs.get(item.index)
            if (!partial) break
            partial.json += item.partialJson
            io.onToolInputDelta?.(partial.id, partial.name, partial.json)
            break
          }
          case 'tool_input_stop':
            toolInputs.delete(item.index)
            break
          case 'text_delta':
            text += item.text
            io.onTextDelta(item.text)
            break
          case 'assistant':
            if (item.parentToolUseId || item.synthetic) break
            if (item.messageId) {
              const known = requests.has(item.messageId)
              requests.set(
                item.messageId,
                Math.max(item.contextTokens ?? 0, requests.get(item.messageId) ?? 0) || null,
              )
              if (item.usage) requestUsage.set(item.messageId, item.usage)
              // A message's first block arrives once its request answered: the turn has one more call done.
              if (!known) {
                const usage = [...requestUsage.values()].reduce(addTokens, { ...EMPTY_TOKENS })
                io.onProgress?.({
                  requests: requests.size,
                  model,
                  billing: claudeCodeProgressBilling(usage, model ?? launch.model),
                  lastContextTokens: requestStats().lastContextTokens,
                })
              }
            }
            if (item.text || item.toolUses.length) io.onTextBoundary(item.text || null)
            if (item.toolUses.length) io.onToolUse?.()
            for (const use of item.toolUses) {
              if (milibotToolName(use.name)) continue
              nativeCalls.set(use.id, { name: use.name, input: use.input })
              io.onNativeToolStart(use.id, use.name, use.input)
            }
            break
          case 'tool_results':
            for (const r of item.results) {
              const call = nativeCalls.get(r.toolUseId)
              nativeCalls.delete(r.toolUseId)
              const diff = call && !r.isError ? claudeCodeFileDiff(call.name, call.input, r.fileChange) : null
              io.onNativeToolFinish(r.toolUseId, r.isError, r.text, diff ? [diff] : [])
            }
            break
          case 'rate_limit':
            if (item.info.status === 'rejected') rateLimited = true
            io.onQuota?.(item.info)
            break
          case 'user_replay': {
            if (!inputEchoed && item.text === payload) {
              inputEchoed = true
              break
            }
            const index = sent.indexOf(item.text)
            if (index < 0) break
            sent.splice(index, 1)
            io.onInputTaken?.()
            break
          }
          case 'result': {
            if (!initialized && !retried && item.isError && MISSING_SESSION.test(item.errors.join('\n'))) {
              // The stored session is gone (deleted, other machine): start over with the memory recap.
              this.log('claude-code session not found; starting a fresh one', { laneKey: key })
              interrupt.dispose()
              await this.rotate(key)
              return this.turn(launch, input, io, true)
            }
            io.onTextBoundary(null)
            if (item.sessionId) {
              this.backend.setSessionId(key, item.sessionId)
              sessionId = item.sessionId
            }
            if (sent.length && !interrupt.interrupted && !item.isError) {
              // A message arrived after the last step: the CLI answers it next, still in this turn.
              earlier.usage = addTokens(earlier.usage, item.usage)
              earlier.durationMs += item.durationMs ?? 0
              break
            }
            open = false
            const whole = { ...item, usage: addTokens(earlier.usage, item.usage) }
            const { costUsd, modelUsage } = turnCost(whole, session.reported, model)
            session.reported = {
              costUsd: item.costUsd ?? session.reported?.costUsd ?? 0,
              models: item.modelUsage,
            }
            return done({
              ok: !item.isError && !interrupt.interrupted,
              text: item.text || text,
              usage: whole.usage,
              durationMs: item.durationMs === null ? null : earlier.durationMs + item.durationMs,
              subtype: interrupt.interrupted ? 'interrupted' : item.subtype,
              error: item.isError ? item.text || item.errors.join('; ') || item.subtype : null,
              costUsd,
              modelUsage,
            })
          }
          case 'exit':
            io.onTextBoundary(null)
            return failed('process_exited', exitMessage('claude', item))
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

  /**
   * Single `claude -p` call without tools, MCP or session (summaries for Claude Code bots). The
   * prompt goes through stdin; the answer is the `result` event (`--output-format json`, or `stream-json`
   * with partial messages when `onText` streams it).
   */
  async oneShot(request: CliOneShot): Promise<CliOneShotResult> {
    const { onText } = request
    const argv = [
      'claude',
      '-p',
      '--output-format',
      ...(onText ? ['stream-json', '--verbose', '--include-partial-messages'] : ['json']),
      '--no-session-persistence',
      '--strict-mcp-config',
      '--tools',
      '',
      '--system-prompt',
      request.systemPrompt,
      ...(request.model ? ['--model', request.model] : []),
    ]
    const answer = (
      outcome: Pick<CliOneShotResult, 'text' | 'usage' | 'durationMs' | 'error'> & {
        costUsd: number | null
        modelUsage: ClaudeModelUsage[]
      },
    ): CliOneShotResult => ({
      text: outcome.text,
      model: outcome.modelUsage[0]?.model ?? request.model ?? DEFAULT_MODEL_NAME,
      usage: outcome.usage,
      billing: claudeCodeUsage(outcome),
      durationMs: outcome.durationMs,
      error: outcome.error,
      request: { argv },
      details: {},
    })
    const failed = (error: string) =>
      answer({ text: '', usage: null, durationMs: null, error, costUsd: null, modelUsage: [] })
    const effort = request.effort ?? pickEffort('low', cliModelInfo('claude_code', request.model)?.efforts)
    const proc = await GuestProcess.start(
      this.backend,
      {
        user: 'agent',
        argv,
        cwd: '/workspace',
        env: {
          ...request.env,
          ...claudeCodeTuningEnv({ effort, maxOutputTokens: request.maxOutputTokens }),
          DISABLE_AUTOUPDATER: '1',
        },
        display: request.bot.displayNum,
        label: oneShotProcLabel(CLAUDE_CODE_PROC_LABEL, request.bot, request.label),
        bot: request.bot.slug,
      },
      { log: this.log, killGraceMs: this.timing.killGraceMs },
    )
    const signal = request.signal ?? new AbortController().signal
    let result: ResultEvent | null = null
    const outcome = new Promise<CliOneShotResult>((resolve) => {
      const onAbort = () => {
        resolve(failed('aborted'))
        void proc.close()
      }
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
      proc.listen({
        line: (text) => {
          const parsed = parseStreamJsonLine(text)
          if (parsed?.type === 'result') result = parsed
          else if (parsed?.type === 'text_delta') onText?.(parsed.text)
        },
        exit: (exit) => {
          signal.removeEventListener('abort', onAbort)
          const done = result as ResultEvent | null
          if (!done) return resolve(failed(exitMessage('claude', exit)))
          resolve(
            answer({
              text: done.isError ? '' : done.text,
              usage: done.usage,
              durationMs: done.durationMs,
              error: done.isError ? done.text || done.errors.join('; ') || done.subtype : null,
              costUsd: done.costUsd,
              modelUsage: done.modelUsage,
            }),
          )
        },
      })
    })
    try {
      await proc.write(request.prompt, true)
    } catch (err) {
      void proc.close()
      throw err
    }
    return outcome
  }
}
