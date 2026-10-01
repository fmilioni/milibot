import { parseMcpToolName, type ToolExecContext, type ToolResult } from '@milibot/agent'
import type { ToolCall } from '@milibot/agent/llm'

import type { ToolProvider } from '../tools-core'
import type { McpService } from './service'

/** The tools of the external MCP servers (`mcp__<server>__<tool>`), by the names the bot sees. */
export class McpTools implements ToolProvider {
  readonly name = 'external MCP'

  constructor(private readonly deps: { mcp: McpService }) {}

  handles(name: string): boolean {
    const parsed = parseMcpToolName(name)
    return parsed !== null && parsed.server !== 'milibot'
  }

  execute(ctx: ToolExecContext, call: ToolCall): Promise<ToolResult> {
    return this.deps.mcp.callTool(ctx, call.name, call.arguments)
  }
}
