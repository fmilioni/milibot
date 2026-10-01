import type { ToolExecContext, ToolResult } from '@milibot/agent'
import type { ToolCall } from '@milibot/agent/llm'
import { type ToolArgs, toolArgs } from '@milibot/agent/tools'

import { toolErrorResult, unknownTool } from './errors'
import type { ToolProvider } from './provider'

export type ToolHandler = (ctx: ToolExecContext, a: ToolArgs) => ToolResult | Promise<ToolResult>
export type ToolHandlers = Readonly<Record<string, ToolHandler>>
/** A family's own mapping of an error its tools throw; undefined falls back to `toolErrorResult`. */
export type ToolErrorMapper = (err: unknown) => ToolResult | undefined

/**
 * Runs `call` with its handler in `table`, parsing the arguments and mapping errors (the family's `mapError`
 * first, then `toolErrorResult`). A stopped turn always rethrows.
 */
export async function runToolSwitch(
  ctx: ToolExecContext,
  call: ToolCall,
  table: ToolHandlers,
  mapError?: ToolErrorMapper,
): Promise<ToolResult> {
  const handler = Object.hasOwn(table, call.name) ? table[call.name] : undefined
  if (!handler) return unknownTool(call.name)
  try {
    return await handler(ctx, toolArgs(call))
  } catch (err) {
    if (ctx.signal.aborted) throw err
    return mapError?.(err) ?? toolErrorResult(err, ctx.signal)
  }
}

/** A family of tools as a table of handlers run by `runToolSwitch`. */
export abstract class ToolSwitch implements ToolProvider {
  abstract readonly name: string
  protected abstract readonly handlers: ToolHandlers

  handles(tool: string): boolean {
    return Object.hasOwn(this.handlers, tool)
  }

  execute(ctx: ToolExecContext, call: ToolCall): Promise<ToolResult> {
    return runToolSwitch(ctx, call, this.handlers, (err) => this.mapError(err))
  }

  protected mapError(_err: unknown): ToolResult | undefined {
    return undefined
  }
}
