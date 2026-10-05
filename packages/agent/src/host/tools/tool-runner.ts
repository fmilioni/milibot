import { type ActivityStep, editedFiles, estimateTokens, newId } from '@milibot/shared'

import type { ToolResult } from '../../environment'
import { textOfParts, type ToolCall } from '../../llm/messages'
import { imageTokens } from '../../memory/tokens'
import { isRepoInstructionText, loadedInstructionFiles } from '../../prompts/repo-instructions'
import { CANCELLED } from '../../prompts/tool-replies'
import { describeToolCall, isNoopToolCall } from '../../tools/describe'
import { MESSAGING_TOOLS } from '../../tools/families/messaging'
import { toolError } from '../../tools/result'
import type { HostContext } from '../context'
import { isBotLane, isScreenTool } from '../lanes'
import { isAbort, type LaneState, StoppedError, type TurnState } from '../state'
import { type HostTool, hostTools } from './host-tools'
import { gateToolCall } from './tool-gate'

function textOf(result: ToolResult): string {
  return textOfParts(result.content, '\n')
}

/** Runs a bot's tool calls: activity steps and logs, pause and screen gating, host or daemon execution. */
export class ToolRunner {
  private hostTools: ReadonlyMap<string, HostTool> | null = null

  constructor(private readonly ctx: HostContext) {}

  /** A call from outside the loop (the MCP server): it joins the lane's running turn in that conversation. */
  runTool(
    botId: string,
    conversationId: string | null,
    call: ToolCall,
    laneKey?: string,
  ): Promise<ToolResult> {
    const lane = this.ctx.lanes.lane(laneKey && isBotLane(laneKey, botId) ? laneKey : botId)
    const turn =
      lane.current && (conversationId === null || lane.current.conversationId === conversationId)
        ? lane.current
        : null
    if (!turn && lane.stopped) return Promise.resolve(toolError(CANCELLED))
    const signal = turn?.abort.signal ?? new AbortController().signal
    return this.execute(botId, turn, turn?.conversationId ?? conversationId, call, signal, lane)
  }

  async execute(
    botId: string,
    turn: TurnState | null,
    conversationId: string | null,
    call: ToolCall,
    signal: AbortSignal,
    toolLane?: LaneState,
  ): Promise<ToolResult> {
    const env = this.ctx.env()
    const { lanes, activity } = this.ctx
    const state = lanes.bot(botId)
    const lane = turn ? lanes.lane(turn.laneKey) : (toolLane ?? lanes.lane(botId))
    const bot = env.getBot(botId)
    if (!bot) return toolError(`unknown bot ${botId}`)
    const describe = { mcpServerName: activity.mcpServerName }
    const { kind, detail } = describeToolCall(call.name, call.arguments, describe)
    const toolCallId = newId('toolCall')
    activity.setFullDetail(
      toolCallId,
      describeToolCall(call.name, call.arguments, { ...describe, full: true }).detail,
    )
    const step: ActivityStep = {
      toolCallId,
      tool: call.name,
      kind,
      detail,
      status: 'running',
      startedAt: env.now(),
      finishedAt: null,
      durationMs: null,
      error: null,
      screenshotSha: null,
    }
    env.startToolCall({
      id: step.toolCallId,
      llmCallId: turn?.llmCallId ?? null,
      botId,
      conversationId,
      turnId: turn?.id ?? null,
      toolName: call.name,
      arguments: call.arguments,
      startedAt: step.startedAt,
    })
    if (turn) activity.acting(turn)
    const shown = !isNoopToolCall(call.name, call.arguments)
    if (turn && shown) {
      activity.foldNarration(turn)
      turn.steps.push(step)
      activity.syncActivity(turn, 'running')
    }
    if (shown) activity.emitAction(step, turn, botId, conversationId)

    let result: ToolResult
    let status: ActivityStep['status'] = 'ok'
    try {
      await this.ctx.control.waitUntilRunnable(lane, signal)
      if (signal.aborted) throw new StoppedError()
      const screenBusy =
        turn && isScreenTool(call.name) ? await this.ctx.screen.acquire(lane, turn, signal, kind) : null
      const refusal = screenBusy
        ? { text: screenBusy, status: 'error' as const }
        : gateToolCall(this.ctx, bot, lane, turn, call)
      if (refusal) {
        result = toolError(refusal.text)
        status = refusal.status
      } else {
        const ref = MESSAGING_TOOLS.has(call.name)
          ? (call.arguments as { bot?: unknown } | null)?.bot
          : undefined
        const target =
          typeof ref === 'string' && ref.trim() ? this.ctx.messaging.findBotRef(ref.trim()) : null
        lanes.setStatus(lane, turn && turn.consecutiveErrors >= 2 ? 'effort' : 'working', kind, target?.id)
        this.hostTools ??= hostTools(this.ctx)
        const hostTool = this.hostTools.get(call.name)
        result = hostTool
          ? await hostTool({ bot, turn, lane, conversationId, call, signal })
          : await env.executeTool(
              {
                bot,
                conversationId,
                turnId: turn?.id ?? null,
                signal,
                laneKey: lane.info.key,
                detach: (wait) => this.ctx.scheduler.detached(lane, turn, wait, kind),
              },
              call,
            )
        if (call.name === 'computer' && result.screenshotSha) state.needsScreenshot = false
        if (result.isError) status = 'error'
      }
    } catch (err) {
      if (isAbort(err, signal)) {
        result = toolError(CANCELLED)
        status = 'cancelled'
      } else {
        result = toolError(`Tool failed: ${(err as Error).message}`)
        status = 'error'
      }
    }
    if (turn) turn.consecutiveErrors = status === 'error' ? turn.consecutiveErrors + 1 : 0
    if (turn)
      for (const part of result.content)
        if (part.type === 'text' && isRepoInstructionText(part.text))
          for (const file of loadedInstructionFiles(part.text))
            (turn.instructionFiles ??= new Map()).set(file.path, file)
    step.screenshotSha = result.screenshotSha ?? null
    if (result.activity) {
      step.detail = result.activity.detail
      activity.setFullDetail(step.toolCallId, result.activity.fullDetail ?? result.activity.detail)
      if (result.activity.result) step.result = result.activity.result
      if (status === 'ok' && result.activity.files?.length) step.files = editedFiles(result.activity.files)
    }
    activity.finishStep(step, status, status === 'ok' ? null : textOf(result).slice(0, 500))
    env.finishToolCall(step.toolCallId, {
      status,
      result: {
        isError: result.isError ?? false,
        text: textOf(result).slice(0, 20_000),
        tokens: result.content.reduce(
          (sum, p) => sum + (p.type === 'text' ? estimateTokens(p.text) : imageTokens(p.width, p.height)),
          0,
        ),
        ...(result.activity ? { detail: result.activity.detail } : {}),
      },
      error: step.error,
      screenshotSha: step.screenshotSha,
      finishedAt: step.finishedAt as number,
      ...(step.files ? { diffs: result.activity?.files } : {}),
    })
    if (turn && shown) activity.syncActivity(turn, 'running')
    if (shown) activity.emitAction(step, turn, botId, conversationId)
    return result
  }
}
