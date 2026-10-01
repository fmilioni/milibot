import { humanToolName } from '@milibot/shared'

import { milibotToolName } from '../mcp/names'
import { isToolName } from '../tools/catalog'
import { type DescribeOptions, describeToolCall, isNoopToolCall } from '../tools/describe'
import { CLI_ENGINE_DRIVERS } from './registry'

/** Activity step of a tool call (`kind` + human detail), or hidden. */
export type CliToolView = { hidden: true } | { hidden: false; kind: string; detail: string }

/**
 * Activity step of a tool call a CLI engine made: Milibot's tools through its MCP server, external MCP tools,
 * or one of the engine's own (each engine names them apart).
 */
export function describeCliTool(name: string, input: unknown, options: DescribeOptions = {}): CliToolView {
  const milibot = milibotToolName(name)
  if (milibot) return { hidden: false, ...describeToolCall(milibot, input, options) }
  if (name.startsWith('mcp__')) return { hidden: false, ...describeToolCall(name, input, options) }
  for (const driver of Object.values(CLI_ENGINE_DRIVERS)) {
    const view = driver.describeTool(name, input, options)
    if (view) return view
  }
  return { hidden: false, kind: 'tool', detail: humanToolName(name) }
}

/**
 * Activity view of any logged tool call (`tool_calls.tool_name`): Milibot tools by their own name, a CLI
 * engine's tools (native or `mcp__milibot__*`) as in the activity card, internal ones hidden.
 */
export function describeActivity(name: string, input: unknown, options: DescribeOptions = {}): CliToolView {
  if (isToolName(name))
    return isNoopToolCall(name, input)
      ? { hidden: true }
      : { hidden: false, ...describeToolCall(name, input, options) }
  return describeCliTool(name, input, options)
}
