import type { ToolExecContext, ToolResult } from '@milibot/agent'
import { HOST_TOOL_NAMES } from '@milibot/agent'
import type { ToolCall } from '@milibot/agent/llm'
import { TOOL_NAMES } from '@milibot/agent/tools'

import { toolErrorResult, type ToolProvider, unknownTool } from '../tools-core'

const AGENT_HOST = 'agent host'

/** Who runs `tool`: the providers that claim it, and the agent host for the tools it runs itself. */
function toolOwners(
  providers: readonly ToolProvider[],
  tool: string,
  hostOwned: readonly string[] = HOST_TOOL_NAMES,
): string[] {
  return [
    ...(hostOwned.includes(tool) ? [AGENT_HOST] : []),
    ...providers.filter((p) => p.handles(tool)).map((p) => p.name),
  ]
}

/**
 * Catalog tools with no owner or with more than one: each tool is run by exactly one provider, or by the
 * agent host itself (memory, messaging, `subagent`).
 */
export function toolOwnershipProblems(
  providers: readonly ToolProvider[],
  catalog: readonly string[] = TOOL_NAMES,
  hostOwned: readonly string[] = HOST_TOOL_NAMES,
): string[] {
  const problems: string[] = []
  for (const tool of catalog) {
    const owners = toolOwners(providers, tool, hostOwned)
    if (owners.length === 0) problems.push(`${tool}: no provider`)
    else if (owners.length > 1) problems.push(`${tool}: ${owners.join(', ')}`)
  }
  return problems
}

/** The daemon's side of `env.executeTool`: the provider that owns the tool runs it. */
export class ToolRegistry {
  constructor(
    private readonly providers: readonly ToolProvider[],
    /** Whatever a tool read reaches the model without secret values. */
    private readonly redact: <T>(value: T) => T,
  ) {
    const problems = toolOwnershipProblems(providers)
    if (problems.length) throw new Error(`tool ownership: ${problems.join('; ')}`)
  }

  owners(tool: string): string[] {
    return toolOwners(this.providers, tool)
  }

  async execute(ctx: ToolExecContext, call: ToolCall): Promise<ToolResult> {
    const provider = this.providers.find((p) => p.handles(call.name))
    if (!provider) return unknownTool(call.name)
    try {
      return this.redact(await provider.execute(ctx, call))
    } catch (err) {
      return this.redact(toolErrorResult(err, ctx.signal))
    }
  }
}
