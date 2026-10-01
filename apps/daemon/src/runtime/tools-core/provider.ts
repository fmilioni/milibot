import type { ToolExecContext, ToolResult } from '@milibot/agent'
import type { ToolCall } from '@milibot/agent/llm'

/** Runs a family of the bots' tools; `name` identifies it in the registry's ownership check. */
export interface ToolProvider {
  readonly name: string
  handles(name: string): boolean
  execute(ctx: ToolExecContext, call: ToolCall): Promise<ToolResult>
}
