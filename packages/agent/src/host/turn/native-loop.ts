import type { NativeResolvedModel } from '../../environment'
import { type ChatMessage, textOfParts } from '../../llm/messages'
import type { CompletionResult } from '../../llm/provider'
import { pruneScreenshots, truncateToolContent } from '../../memory/chat-messages'
import { EMPTY_SESSION_REPLY_NOTE, STEP_LIMIT_NOTE, USER_WROTE_MEANWHILE_NOTE } from '../../prompts/notes'
import { USER_TOOK_CONTROL_NOTE } from '../../prompts/rules'
import { CANCELLED } from '../../prompts/tool-replies'
import { toolError } from '../../tools/result'
import { sessionBudget } from '../../work-sessions/transcript'
import type { HostContext } from '../context'
import type { TurnEngine, TurnRun } from '../engines'
import { isAbort } from '../state'
import { compactSession } from '../work-sessions/session-compaction'
import { nativeContext } from './native-context'
import { recordNativeCall } from './one-shot'

const SUBAGENT_MAX_STEPS = 60

/** The step loop of an API model: stream a response, run its tool calls, repeat until it answers. */
export class NativeLoop implements TurnEngine<NativeResolvedModel> {
  constructor(private readonly ctx: HostContext) {}

  async run({ bot, request, turn }: TurnRun, initial: NativeResolvedModel): Promise<void> {
    const ctx = this.ctx
    const env = ctx.env()
    const state = ctx.lanes.bot(bot.id)
    const lane = ctx.lanes.lane(turn.laneKey)
    const found = ctx.sessions.forTurn(bot, lane)
    if (found === 'missing') return
    const context = await nativeContext(ctx, bot, request, turn, lane, found.session, initial)
    const { helper, session, tools, system, conversation, transcript } = context
    const kind = lane.info.kind
    const maxSteps = helper
      ? SUBAGENT_MAX_STEPS
      : kind === 'session'
        ? ctx.options.sessionMaxSteps
        : ctx.options.maxSteps
    if (conversation.length === 0) return
    const signal = turn.abort.signal
    // Session lanes store every entry as it enters the context (their next turns replay it).
    const push = (message: ChatMessage) => {
      conversation.push(message)
      if (session && transcript)
        transcript.seqs.push(env.workSessions.appendTranscript(session.id, lane.info.key, turn.id, message))
    }

    // What the user wrote in this conversation while the turn worked enters it between two steps.
    const joinIncoming = (): boolean => {
      if (!turn.incoming) return false
      turn.incoming = false
      const parts = session
        ? ctx.sessions.newMessages(bot, session, lane.info.key)
        : ctx.inputs.unreadParts(bot, turn.conversationId)
      if (parts.length === 0) return false
      ctx.activity.continueBelow(turn)
      push({ role: 'user', content: [{ type: 'text', text: USER_WROTE_MEANWHILE_NOTE }, ...parts] })
      return true
    }

    let resolved = initial
    let triedFallback = false
    let nudgedEmpty = false
    // Past the step limit the model gets one call without tools to write its final message.
    let closing = false
    for (let step = 1; ; step++) {
      if (signal.aborted) return
      if (ctx.scheduler.isHeld()) {
        await ctx.scheduler.waitUnheld(signal)
        if (signal.aborted) return
      }
      if (step > maxSteps && !closing) {
        if (helper) {
          helper.failure = `it reached the limit of ${maxSteps} steps`
          return
        }
        ctx.lanes.systemLine(
          bot.id,
          'max_steps_reached',
          `${bot.name} reached the limit of ${maxSteps} steps in one turn`,
          {
            lane,
            params: { maxSteps },
          },
        )
        closing = true
        push({ role: 'user', content: [{ type: 'text', text: STEP_LIMIT_NOTE }] })
      }
      if (state.pendingNote) {
        state.pendingNote = false
        push({ role: 'user', content: [{ type: 'text', text: USER_TOOK_CONTROL_NOTE }] })
      }
      if (step > 1) joinIncoming()
      if (session && transcript)
        await compactSession(ctx, {
          bot,
          session,
          laneKey: lane.info.key,
          system,
          conversation,
          transcript,
          tools,
          budget: sessionBudget(resolved.contextWindow),
          signal,
        })
      pruneScreenshots(conversation)
      const messages: ChatMessage[] = [system, ...conversation]
      const contextComposition = context.compose()
      ctx.lanes.setStatus(lane, turn.consecutiveErrors >= 2 ? 'effort' : 'thinking')

      const text = ctx.activity.textStream(bot, turn)
      turn.text = text
      const draft = ctx.activity.draftForwarder(bot, turn)
      let result: CompletionResult | null = null
      const started = env.now()
      try {
        for await (const chunk of resolved.provider.stream({
          model: resolved.model,
          messages,
          tools,
          blobs: env.blobs,
          maxOutputTokens: resolved.maxOutputTokens ?? undefined,
          effort: resolved.effort,
          ...(closing ? { toolChoice: 'none' as const } : {}),
          signal,
        })) {
          if (chunk.type === 'text_delta') {
            text.push(chunk.text)
            ctx.lanes.setStatus(lane, 'talking')
          } else if (chunk.type === 'tool_input_delta') {
            draft(chunk.id, chunk.name, chunk.partialJson)
          } else if (chunk.type === 'done') {
            result = chunk.result
          }
        }
      } catch (err) {
        text.end()
        if (isAbort(err, signal)) return
        turn.llmCallId = recordNativeCall(
          env,
          { botId: bot.id, conversationId: turn.conversationId, turnId: turn.id, purpose: 'turn' },
          resolved,
          contextComposition,
          { error: err, latencyMs: env.now() - started },
        )
        if (!text.started && !triedFallback) {
          triedFallback = true
          const fallback = await env.resolveFallbackModel(bot).catch(() => null)
          if (
            fallback?.kind === 'native' &&
            !(fallback.providerId === resolved.providerId && fallback.model === resolved.model)
          ) {
            env.log('warn', 'provider failed: retrying with the fallback model', {
              botId: bot.id,
              model: fallback.model,
              err: (err as Error).message,
            })
            resolved = fallback
            step--
            continue
          }
        }
        ctx.turns.errorCard(turn, 'provider_error', (err as Error).message)
        return
      }
      if (!result) return
      turn.llmCallId = recordNativeCall(
        env,
        {
          botId: bot.id,
          conversationId: turn.conversationId,
          turnId: turn.id,
          purpose: request.trigger === 'intro' ? 'intro' : 'turn',
        },
        resolved,
        contextComposition,
        { result },
      )
      const assistantText = textOfParts(result.message.content)
      ctx.activity.textEnded(turn, text.end(assistantText || null))
      if (closing) {
        if (assistantText.trim()) push({ role: 'assistant', content: result.message.content })
        return
      }
      const calls = result.message.toolCalls ?? []
      // A session turn ending in silence leaves the session running with nobody working on it; the empty
      // reply itself stays out of the context (some APIs refuse an assistant message without content).
      if (calls.length === 0 && kind === 'session' && !assistantText.trim() && !nudgedEmpty) {
        nudgedEmpty = true
        env.log('warn', 'empty reply in a work session: asking the model again', {
          botId: bot.id,
          laneKey: lane.info.key,
          model: resolved.model,
        })
        push({ role: 'user', content: [{ type: 'text', text: EMPTY_SESSION_REPLY_NOTE }] })
        continue
      }
      push(result.message)
      if (calls.length === 0) {
        if (joinIncoming()) continue
        return
      }
      ctx.activity.foldNarration(turn)
      // Helpers asked for in one response work at the same time; the other tools run in order.
      const execute = (call: (typeof calls)[number]) =>
        ctx.tools.execute(bot.id, turn, turn.conversationId, call, signal)
      const helpers = new Map(
        calls
          .filter((call) => call.name === 'subagent' && !signal.aborted)
          .map((call) => [call.id, execute(call)]),
      )
      for (const call of calls) {
        const toolResult = signal.aborted
          ? toolError(CANCELLED)
          : await (helpers.get(call.id) ?? execute(call))
        push({
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content: truncateToolContent(toolResult.content),
          ...(toolResult.isError ? { isError: true } : {}),
        })
      }
      if (signal.aborted) return
    }
  }
}
