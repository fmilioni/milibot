import {
  type ActivityStep,
  type Bot,
  CLI_ENGINE_INFO,
  type CliEngine,
  editedFiles,
  estimateTokens,
  type InstructionFileInfo,
  LLM_CALL_RUNNING,
  type StepFileDiff,
} from '@milibot/shared'

import type { CliSessions, CliTurnProgress } from '../../cli/engine'
import { splitEngineInstructions } from '../../cli/instructions'
import { cliPrompt } from '../../cli/prompt'
import { CLI_ENGINE_DRIVERS } from '../../cli/registry'
import {
  cliComposition,
  type CliSessionMeta,
  measureBaseTokens,
  type RotationReason,
  rotationReason,
} from '../../cli/rotation'
import type { CliRotationSettings } from '../../cli/settings'
import { type CliStartup, EMPTY_BOOTSTRAP_SECTIONS, emptyStartup } from '../../cli/startup'
import type { AgentEnvironment, CliResolvedModel, LlmCallRecord, WorkSessionView } from '../../environment'
import { memoryDigest } from '../../memory/bootstrap'
import { sessionRules, subagentRules } from '../../prompts/lanes'
import { projectNote, USER_WROTE_MEANWHILE_NOTE } from '../../prompts/notes'
import { loadedInstructionFiles, repoInstructionTexts } from '../../prompts/repo-instructions'
import { introInstruction, personaSection, USER_TOOK_CONTROL_NOTE } from '../../prompts/rules'
import type { HostContext } from '../context'
import type { TurnEngine, TurnRun } from '../engines'
import type { LaneKey } from '../lanes'
import type { LaneState, TurnState } from '../state'
import { subagentInput, type SubagentRun } from '../subagents'
import { teamOf } from './native-context'
import { promptTokens } from './one-shot'

/** What a CLI turn works in: its lane, work session and helper. */
interface CliLane {
  lane: LaneState
  laneKey: LaneKey
  session: WorkSessionView | null
  helper: SubagentRun | null
}

/** Shortest time between two writes of a running turn's call (each one reloads the debug panels showing it). */
const PROGRESS_INTERVAL_MS = 1_500

/**
 * The `llm_calls` row of a CLI turn, which is one engine run of many model requests (a session's can last
 * hours): written as `LLM_CALL_RUNNING` when its first request completes, kept current (throttled) after each
 * one, then replaced by the result. Without it the debug panel showed nothing until the turn ended.
 */
class LiveCall {
  private id: string | null = null
  private pending: CliTurnProgress | null = null
  private last: CliTurnProgress | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastWrite = Number.NEGATIVE_INFINITY

  constructor(
    private readonly env: AgentEnvironment,
    private readonly recordOf: (progress: CliTurnProgress) => LlmCallRecord,
    private readonly onRecorded: (id: string) => void,
  ) {}

  progress(progress: CliTurnProgress): void {
    this.pending = progress
    if (this.timer) return
    const wait = this.lastWrite + PROGRESS_INTERVAL_MS - this.env.now()
    if (wait <= 0) this.flush()
    else this.timer = setTimeout(() => this.flush(), wait)
  }

  /** Writes the result over the running row (or records it when the turn reported no progress). */
  finish(record: LlmCallRecord): string {
    this.stop()
    if (!this.id) return this.env.recordLlmCall(record)
    this.env.updateLlmCall(this.id, record)
    return this.id
  }

  /** `run`'s result; if it throws, the row (if any) ends with the error instead of staying `running`. */
  async settle<T>(run: Promise<T>): Promise<T> {
    try {
      return await run
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  private fail(error: string): void {
    this.stop()
    const progress = this.last
    if (this.id && progress)
      this.env.updateLlmCall(this.id, { ...this.recordOf(progress), stopReason: 'error', error })
  }

  private stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending = null
  }

  private flush(): void {
    this.timer = null
    const progress = this.pending
    this.pending = null
    if (!progress) return
    this.last = progress
    this.lastWrite = this.env.now()
    const record = this.recordOf(progress)
    if (this.id) {
      this.env.updateLlmCall(this.id, record)
      return
    }
    this.id = this.env.recordLlmCall(record)
    this.onRecorded(this.id)
  }
}

/** Session lanes keep their CLI session through idle time and growth: only another model or profile rotates it. */
const SESSION_ROTATION: CliRotationSettings = {
  rotateIdleMinutes: Number.POSITIVE_INFINITY,
  rotateContextTokens: Number.POSITIVE_INFINITY,
}

/** A lane chosen with a context limit rotates its CLI session when the context passes it. */
function withContextLimit<S extends CliRotationSettings>(
  settings: S,
  contextLimit: number | null | undefined,
): S {
  return contextLimit ? { ...settings, rotateContextTokens: contextLimit } : settings
}

/** Turns of the CLI engines: one process per lane, driven through the engine's `CliSessions`. */
export class CliTurns implements TurnEngine<CliResolvedModel> {
  constructor(private readonly ctx: HostContext) {}

  async run(turnRun: TurnRun, resolved: CliResolvedModel): Promise<void> {
    const { bot, request, turn } = turnRun
    const ctx = this.ctx
    const env = ctx.env()
    const engine = resolved.engine
    const driver = CLI_ENGINE_DRIVERS[engine]
    const sessions = ctx.cli.get(engine)
    if (!sessions) {
      ctx.turns.errorCard(
        turn,
        'cli_unavailable',
        `${driver.displayName} needs the workspace VM, which is not available.`,
        { engine },
      )
      return
    }
    const lane = ctx.lanes.lane(turn.laneKey)
    const found = ctx.sessions.forTurn(bot, lane)
    if (found === 'missing') return
    const where: CliLane = {
      lane,
      laneKey: lane.info.key,
      session: found.session,
      helper: ctx.helpers.get(lane.info.key) ?? null,
    }
    const { laneKey, session, helper } = where
    const skills = env.skillContext(bot, lane.info.kind)
    const readOnly = helper?.readOnly === true
    const settings = driver.settings((key, fallback) => env.getSetting(key, fallback))
    const prompt = cliPrompt(
      engine,
      bot,
      teamOf(env.listBots()),
      env.userLanguage(),
      lane.info.kind,
      skills,
      {
        readOnly,
      },
    )
    const laneRules = helper
      ? subagentRules(session, helper.readOnly, driver.wording)
      : session
        ? sessionRules(session, driver.wording, skills.families.has('secrets'))
        : null
    const instructions = laneRules ? `${prompt.instructions}\n\n${laneRules}` : prompt.instructions
    const nativeTools = driver.nativeTools({ inSession: session !== null, readOnly })
    const external = readOnly
      ? null
      : await env.cliMcp(bot, engine).catch((err: unknown) => {
          env.log('warn', 'external MCP servers unavailable', { botId: bot.id, err: (err as Error).message })
          return null
        })
    // A session's CLI session lives as long as the work: persona or team edits do not restart it, and it is
    // not rotated for size or idleness (the engine compacts it itself).
    const profile = driver.profile({
      settings,
      instructions: laneRules ?? prompt.instructions,
      mcpTools: prompt.mcpTools,
      nativeTools,
      externalFingerprint: external?.fingerprint ?? '',
    })
    // A session's folder is the CLI's working folder: Milibot adds the instruction files the CLI would miss.
    const repo = session ? await this.repoInstructions(engine, bot, session.cwd, turn.abort.signal) : null
    const repoText = repo ? repoInstructionTexts(repo.missing).join('\n\n') : ''
    const { meta, rotation } = await this.rotate(bot, turn, sessions, where, { profile, resolved, settings })
    const { input, lastProject, projectSent } = await this.input(turnRun, where, meta)
    const cb = this.callbacks(bot, turn, lane, session !== null)
    const started = env.now()
    const purpose = request.trigger === 'intro' ? 'intro' : 'turn'
    // What the CLI read by itself, what the process started with (a session's stored bootstrap) and what
    // Milibot's tools brought this turn.
    const instructionFiles = (): InstructionFileInfo[] => {
      const appendix = helper
        ? repoText
        : session
          ? (env.hostState.cliBootstrap(engine, laneKey)?.appendix ?? '')
          : ''
      const injected = new Map(loadedInstructionFiles(appendix).map((f) => [f.path, f]))
      for (const file of turn.instructionFiles?.values() ?? []) injected.set(file.path, file)
      return [
        ...(repo?.engine ?? []).map((f) => ({
          path: f.path,
          bytes: f.bytes,
          truncated: false,
          source: 'engine' as const,
        })),
        ...[...injected.values()].map((f) => ({ ...f, source: 'injected' as const })),
      ]
    }
    const live = new LiveCall(
      env,
      (progress) => ({
        botId: bot.id,
        conversationId: turn.conversationId,
        turnId: turn.id,
        purpose,
        providerId: resolved.providerId,
        providerType: engine,
        model: progress.model ?? resolved.model ?? CLI_ENGINE_INFO[engine].defaultModel,
        request: { input },
        response: { requests: progress.requests, lastContextTokens: progress.lastContextTokens },
        ...progress.billing,
        contextComposition: null,
        instructionFiles: instructionFiles(),
        stopReason: LLM_CALL_RUNNING,
        generationId: null,
        latencyMs: env.now() - started,
        error: null,
      }),
      // Milibot tools the turn calls from now on point at it.
      (id) => (turn.llmCallId = id),
    )
    const running = sessions.runTurn(
      {
        bot,
        key: laneKey,
        model: resolved.model,
        tuning: {
          effort: resolved.effort ?? null,
          contextLimit: resolved.contextLimit ?? null,
          maxOutputTokens: resolved.maxOutputTokens ?? null,
        },
        env: resolved.env,
        ...(resolved.config ? { providerConfig: resolved.config } : {}),
        idleTimeoutMs: resolved.idleTimeoutMs,
        instructions,
        systemPrompt: settings.systemPrompt,
        nativeTools,
        readOnly,
        ...(session ? { cwd: session.cwd } : {}),
        startup: this.startup(engine, bot, turn, where, repoText),
        externalMcp: external,
        mcpTools: prompt.mcpTools,
      },
      input,
      {
        signal: turn.abort.signal,
        onMcpStatus: (connected, error) => {
          if (!connected)
            env.log('warn', 'milibot MCP server not connected', { botId: bot.id, engine, error })
        },
        onTextDelta: cb.onTextDelta,
        onTextBoundary: cb.onTextBoundary,
        onQuota: (update) => env.cliQuota(resolved.providerId, engine, update),
        onAcceptingInput: cb.onAcceptingInput,
        onInputTaken: cb.onInputTaken,
        onToolInputDelta: ctx.activity.draftForwarder(bot, turn),
        onToolUse: cb.onToolUse,
        onNativeToolStart: cb.startStep,
        onNativeToolFinish: cb.finishStep,
        onProgress: (progress) => live.progress(progress),
      },
    )
    const result = await live.settle(running)
    turn.deliver = null
    ctx.activity.textEnded(turn, cb.text.end())
    const launched = result.launched
    const { parts, sameSession, measuredBase, baseTokens } = this.composition({
      engine,
      laneKey,
      launched,
      persona: instructions,
      mcpTools: prompt.mcpTools,
      tokensByServer: external?.tokensByServer,
      rawInput: input,
      meta,
      sessionId: result.sessionId,
      firstContextTokens: result.firstContextTokens,
      estimatedBase: driver.estimatedBaseTokens(settings),
    })
    if (result.sessionId && !helper) {
      env.hostState.setCliMeta(engine, laneKey, {
        sessionId: result.sessionId,
        profile,
        model: resolved.model,
        lastUsedAt: env.now(),
        contextTokens: result.lastContextTokens ?? (sameSession ? (meta?.contextTokens ?? null) : null),
        baseTokens: measuredBase ?? (sameSession ? (meta?.baseTokens ?? null) : null),
        lastProject: sameSession || projectSent !== lastProject ? projectSent : null,
      })
    }
    turn.llmCallId = live.finish({
      botId: bot.id,
      conversationId: turn.conversationId,
      turnId: turn.id,
      purpose,
      providerId: resolved.providerId,
      providerType: engine,
      model: result.model,
      request: {
        ...result.request,
        input,
        ...(launched?.startup.inputPrefix ? { inputPrefix: launched.startup.inputPrefix } : {}),
        freshSession: launched?.fresh ?? null,
        ...(rotation ? { rotated: rotation } : {}),
      },
      response: {
        subtype: result.subtype,
        text: result.text,
        sessionId: result.sessionId,
        requests: result.requests,
        firstContextTokens: result.firstContextTokens,
        lastContextTokens: result.lastContextTokens,
        ...result.details,
        events: result.events,
      },
      ...result.billing,
      instructionFiles: instructionFiles(),
      contextComposition: {
        ...cliComposition(
          { ...parts, base: baseTokens },
          result.requests,
          result.usage ? promptTokens(result.usage) : 0,
          external?.tokensByServer,
        ),
        persona: Math.max(1, result.requests) * estimateTokens(personaSection(bot)),
      },
      stopReason: result.subtype,
      generationId: result.sessionId,
      latencyMs: result.durationMs ?? env.now() - started,
      error: result.error?.message ?? null,
    })
    if (result.error) ctx.turns.errorCard(turn, result.error.code, result.error.message, { engine })
  }

  /**
   * What the process loads when it starts: a helper only the repository instructions its CLI misses, else the
   * session's (with them) or the chat's memory.
   */
  private startup(
    engine: CliEngine,
    bot: Bot,
    turn: TurnState,
    where: CliLane,
    repoText: string,
  ): (fresh: boolean) => CliStartup {
    if (where.helper)
      return repoText
        ? () => ({ systemAppendix: repoText, inputPrefix: null, sections: EMPTY_BOOTSTRAP_SECTIONS })
        : emptyStartup
    if (where.session)
      return this.ctx.sessions.cliStartup(engine, bot, where.session, where.laneKey, repoText)
    return this.ctx.memory.cliStartup(engine, bot, turn.conversationId, where.laneKey)
  }

  /** The instruction files of the chain from the repository root to `cwd`: read by the CLI, or missing. */
  private async repoInstructions(engine: CliEngine, bot: Bot, cwd: string, signal: AbortSignal) {
    const env = this.ctx.env()
    const files = await env.repoInstructions(bot, [cwd], signal).catch((err: unknown) => {
      env.log('warn', 'repository instructions unavailable', { botId: bot.id, err: (err as Error).message })
      return []
    })
    return splitEngineInstructions(CLI_ENGINE_INFO[engine].instructionFiles, files)
  }

  /**
   * Replaces the lane's stored CLI session by a fresh one when it is idle, too big, from another model or
   * started with another profile (see `rotationReason`); returns the meta still valid, and why it rotated.
   */
  private async rotate(
    bot: Bot,
    turn: TurnState,
    sessions: CliSessions,
    where: CliLane,
    input: { profile: string; resolved: CliResolvedModel; settings: CliRotationSettings },
  ): Promise<{ meta: CliSessionMeta | null; rotation: RotationReason | null }> {
    const env = this.ctx.env()
    const { engine } = input.resolved
    const storedMeta = env.hostState.cliMeta(engine, where.laneKey)
    // A helper's CLI session lives for its one turn (dropped with its lane).
    const rotation = where.helper
      ? null
      : rotationReason({
          sessionId: sessions.storedSessionId(where.laneKey),
          meta: storedMeta,
          profile: input.profile,
          model: input.resolved.model,
          now: env.now(),
          settings: withContextLimit(
            where.session ? SESSION_ROTATION : input.settings,
            input.resolved.contextLimit,
          ),
        })
    if (rotation) {
      env.log('info', 'cli session rotated', {
        botId: bot.id,
        laneKey: where.laneKey,
        engine,
        reason: rotation,
      })
      await sessions.rotate(where.laneKey)
      if (rotation !== 'config_changed' && storedMeta) {
        const idleMinutes = Math.round((env.now() - storedMeta.lastUsedAt) / 60_000)
        const fallback = {
          idle: `${bot.name} picked up from memory after ${idleMinutes} idle minutes`,
          context_size: `${bot.name} moved the conversation into memory to keep going lighter`,
          model_changed: `${bot.name} switched to the new model`,
        }[rotation]
        this.ctx.lanes.systemLine(bot.id, 'session_rotated', fallback, {
          lane: where.lane,
          params: { reason: rotation, idleMinutes, contextTokens: storedMeta.contextTokens ?? 0 },
        })
      }
    }
    return { meta: rotation ? null : storedMeta, rotation }
  }

  /**
   * Input of a CLI turn: the helper's task, or what arrived in the conversation after the turn's documents and
   * notes (`TurnInput`). One CLI session serves every conversation of the bot, so a chat turn also says which
   * project applies, with its whole block when the session has not seen it yet.
   */
  private async input(
    { bot, request, turn }: TurnRun,
    where: CliLane,
    meta: CliSessionMeta | null,
  ): Promise<{
    input: string
    lastProject: CliSessionMeta['lastProject'] | null
    projectSent: CliSessionMeta['lastProject'] | null
  }> {
    const { lane, session, helper } = where
    const inputs = this.ctx.inputs
    const state = this.ctx.lanes.bot(bot.id)
    const lastProject = meta?.lastProject ?? null
    let projectSent = lastProject
    let parts: string[]
    if (helper) parts = [subagentInput(helper, session)]
    else if (request.trigger === 'intro') parts = [introInstruction(bot)]
    else {
      const unread = inputs.takeUnread(bot, request)
      const lines = inputs.lines(bot, unread.pending, session !== null)
      const query = lines.join('\n\n')
      const signal = turn.abort.signal
      if (session) {
        // The session's project is in its bootstrap.
        parts = [...(await inputs.head(bot, request, lane, signal, { session, query })), ...lines]
      } else {
        const project = this.ctx.knowledge.currentProject(bot, turn.conversationId, lane.info.kind)
        const projectDigest = project ? memoryDigest(project.block) : null
        const newProject =
          !!project && (lastProject?.projectId !== project.id || lastProject.digest !== projectDigest)
        if (project && newProject) projectSent = { projectId: project.id, digest: projectDigest as string }
        const head = await inputs.head(bot, request, lane, signal, {
          session: null,
          projectId: project?.id ?? null,
          query,
          missedRoutine: unread.missedRoutine,
        })
        parts = [project || lastProject ? projectNote(project, newProject) : '', ...head, ...lines]
      }
    }
    if (state.pendingNote) {
      state.pendingNote = false
      parts.unshift(USER_TOOK_CONTROL_NOTE)
    }
    const input = parts.filter(Boolean).join('\n\n') || '(continue)'
    return { input, lastProject, projectSent }
  }

  /** Sends a CLI turn what the user wrote in its conversation since it last read it. */
  private deliver(bot: Bot, turn: TurnState, inSession: boolean, send: (text: string) => boolean): void {
    if (!turn.incoming) return
    const reads = this.ctx.reads
    const { messages, pending } = reads.pendingMessages(bot, turn.conversationId)
    const lines = this.ctx.inputs.lines(bot, pending, inSession)
    if (lines.length && !send([USER_WROTE_MEANWHILE_NOTE, ...lines].join('\n\n'))) return
    reads.markRead(bot.id, turn.conversationId, messages)
    turn.incoming = false
  }

  /**
   * Callbacks a CLI turn streams into the chat: text and its boundaries, native tool steps (with their
   * diffs), messages taken in mid-turn.
   */
  private callbacks(bot: Bot, turn: TurnState, lane: LaneState, inSession: boolean) {
    const env = this.ctx.env()
    const { activity, lanes } = this.ctx
    const text = activity.textStream(bot, turn)
    turn.text = text
    const steps = new Map<string, ActivityStep | null>()
    return {
      text,
      onTextDelta: (delta: string) => {
        text.push(delta)
        lanes.setStatus(lane, 'talking', undefined, undefined, 'reply')
      },
      onTextBoundary: (fullText: string | null) => {
        const full = fullText?.trim() ?? ''
        if (!text.started && full && turn.lastFolded && full.startsWith(turn.lastFolded)) {
          // The rest of a text already folded when a Milibot tool call overtook the stream.
          activity.addNote(turn, full)
        } else if (text.started || full) activity.textEnded(turn, text.end(fullText))
        lanes.setStatus(lane, 'thinking', undefined, undefined, 'llm')
      },
      onAcceptingInput: (send: (text: string) => boolean) => {
        turn.deliver = () => this.deliver(bot, turn, inSession, send)
        turn.deliver()
      },
      onInputTaken: () => activity.continueBelow(turn),
      onToolUse: () => activity.foldNarration(turn),
      startStep: (id: string, name: string, toolInput: unknown) => {
        const step = activity.startExternalStep(turn, id, name, toolInput)
        steps.set(id, step)
        if (step) lanes.setStatus(lane, 'working', step.kind, undefined, 'tool')
      },
      /** Only a shown, successful step keeps its diffs. */
      finishStep: (id: string, isError: boolean, output: string, changed: StepFileDiff[]) => {
        if (!steps.has(id)) return
        const step = steps.get(id) ?? null
        steps.delete(id)
        const error = isError ? output.slice(0, 500) : null
        const diffs = step && !isError ? changed : []
        if (step) {
          if (diffs.length) step.files = editedFiles(diffs)
          activity.finishStep(step, isError ? 'error' : 'ok', error)
        }
        env.finishToolCall(id, {
          status: isError ? 'error' : 'ok',
          result: { text: output.slice(0, 20_000) },
          error,
          screenshotSha: null,
          finishedAt: step?.finishedAt ?? env.now(),
          ...(diffs.length ? { diffs } : {}),
        })
        if (!step) return
        activity.syncActivity(turn, 'running')
        activity.emitAction(step, turn, bot.id, turn.conversationId)
      },
    }
  }

  /** Composition parts of a CLI turn and the base tokens (measured on a fresh session, else remembered). */
  private composition(input: {
    engine: CliEngine
    laneKey: LaneKey
    launched: { fresh: boolean; startup: CliStartup } | null
    persona: string
    mcpTools: unknown
    tokensByServer: Record<string, number> | undefined
    rawInput: string
    meta: CliSessionMeta | null
    sessionId: string | null
    firstContextTokens: number | null
    estimatedBase: number
  }) {
    const sections =
      input.launched?.startup.sections ??
      this.ctx.env().hostState.cliBootstrap(input.engine, input.laneKey)?.sections ??
      EMPTY_BOOTSTRAP_SECTIONS
    const parts = {
      persona: estimateTokens(input.persona),
      mcpTools:
        estimateTokens(JSON.stringify(input.mcpTools)) +
        Object.values(input.tokensByServer ?? {}).reduce((sum, v) => sum + v, 0),
      ...sections,
      input: estimateTokens(input.rawInput),
    }
    const sameSession = input.meta !== null && input.meta.sessionId === input.sessionId
    const measuredBase = input.launched?.fresh ? measureBaseTokens(input.firstContextTokens, parts) : null
    const baseTokens = measuredBase ?? (sameSession ? input.meta?.baseTokens : null) ?? input.estimatedBase
    return { parts, sameSession, measuredBase, baseTokens }
  }
}
