import type { Bot } from '@milibot/shared'

import type { ToolResult } from '../../environment'
import type { ToolCall } from '../../llm/messages'
import { executeMemoryTool } from '../../memory/tools'
import type { ToolName } from '../../tools/catalog'
import { memoryTools } from '../../tools/families/memory'
import type { HostContext } from '../context'
import type { LaneState, TurnState } from '../state'

/** A tool call the host runs itself. */
export interface HostToolCall {
  bot: Bot
  turn: TurnState | null
  lane: LaneState
  conversationId: string | null
  call: ToolCall
  signal: AbortSignal
}

export type HostTool = (call: HostToolCall) => ToolResult | Promise<ToolResult>

/** Tools the host runs itself; every other tool goes to the environment's `executeTool`. */
export const HOST_TOOL_NAMES = [
  ...memoryTools.names,
  'ask_bot',
  'message_bot',
  'after_current_work',
  'subagent',
] as const satisfies readonly ToolName[]

type HostToolName = (typeof HOST_TOOL_NAMES)[number]

export function hostTools(ctx: HostContext): ReadonlyMap<string, HostTool> {
  const memoryTool: HostTool = ({ bot, conversationId, call }) => {
    const env = ctx.env()
    return executeMemoryTool(
      {
        bot,
        conversationId,
        botsById: ctx.botsById(),
        memory: env.memory,
        projectId: ctx.knowledge.projectOf(conversationId),
        projects: env.projects,
      },
      call,
    )
  }
  const tools: Record<HostToolName, HostTool> = {
    ...(Object.fromEntries(memoryTools.names.map((name) => [name, memoryTool])) as Record<
      (typeof memoryTools.names)[number],
      HostTool
    >),
    ask_bot: (c) => ctx.messaging.messageBot(c),
    message_bot: (c) => ctx.messaging.messageBot(c),
    after_current_work: (c) => ctx.otherWork.afterCurrentWork(c),
    subagent: (c) => ctx.helpers.run(c.bot, c.turn, c.lane, c.call, c.signal),
  }
  return new Map(Object.entries(tools))
}
