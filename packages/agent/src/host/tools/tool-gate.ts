import type { Bot } from '@milibot/shared'

import type { ToolCall } from '../../llm/messages'
import { gateReplies } from '../../prompts/tool-replies'
import { toolAlias, toolAllowedInLane, toolEnabled } from '../../tools/policy'
import type { HostContext } from '../context'
import type { LaneState, TurnState } from '../state'

export interface ToolRefusal {
  text: string
  status: 'error' | 'cancelled'
}

/** Why a tool call may not run in `lane` (null: it may), with the status its step gets. */
export function gateToolCall(
  ctx: HostContext,
  bot: Bot,
  lane: LaneState,
  turn: TurnState | null,
  call: ToolCall,
): ToolRefusal | null {
  const args = call.arguments as { action?: unknown } | null
  const kind = lane.info.kind
  if (!toolAllowedInLane(call.name, kind)) return { status: 'error', text: gateReplies.notHere(call.name) }
  if (!toolEnabled(call.name, kind, ctx.env().skillContext(bot, kind).families))
    return { status: 'error', text: gateReplies.skillOff(call.name) }
  if (ctx.helpers.get(lane.info.key)?.readOnly && !toolAllowedInLane(call.name, kind, true))
    return { status: 'error', text: gateReplies.readOnly(call.name) }
  if (turn?.offeredTools && !turn.offeredTools.has(call.name)) {
    const alias = toolAlias(call.name)
    return {
      status: 'error',
      text:
        alias && turn.offeredTools.has(alias)
          ? gateReplies.useAlias(call.name, alias)
          : gateReplies.notInTurn(call.name),
    }
  }
  if (
    call.name === 'computer' &&
    ctx.lanes.bot(bot.id).needsScreenshot &&
    args?.action !== 'screenshot' &&
    args?.action !== 'wait'
  )
    return { status: 'cancelled', text: gateReplies.userTookControl }
  return null
}
