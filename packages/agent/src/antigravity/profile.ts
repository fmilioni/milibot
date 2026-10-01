import { createHash } from 'node:crypto'

import type { Bot } from '@milibot/shared'

import type { CliProfileInput } from '../cli/engine'
import { laneSuffix } from '../cli/lane'
import type { CliMcpConfig } from '../cli/mcp-config'
import type { LaneKey } from '../host/lanes'
import type { ToolDefinition } from '../llm/provider'
import { MILIBOT_MCP_SERVER } from '../mcp/names'
import { ANTIGRAVITY_LANE_TOOLS } from './tools'

/** Estimated tokens of `agy`'s tool declarations in a lane (its own system prompt is replaced), before a session measures them. */
export const ESTIMATED_ANTIGRAVITY_BASE_TOKENS = 3_000

/**
 * Identifies what a conversation was started with: native tools, Milibot's agent prompt (rules + persona +
 * team + skills catalog), MCP tool docs and the external MCP servers (without secret values). `agy` reads the
 * agent prompt when the process starts; memory is left out (it reaches a resumed conversation in its input).
 */
export function antigravityProfile(input: CliProfileInput): string {
  const source = JSON.stringify([
    input.nativeTools ?? ANTIGRAVITY_LANE_TOOLS,
    input.instructions,
    input.mcpTools,
    ...(input.externalFingerprint ? [input.externalFingerprint] : []),
  ])
  return createHash('sha256').update(source).digest('hex').slice(0, 12)
}

/**
 * Folder under `~/.milibot` the agent files are written to; the installer links `~/.gemini/config/agents` to it
 * (where `agy` discovers agents, one folder each).
 */
export const ANTIGRAVITY_AGENTS_DIR = 'agy-agents'

/** Name of a lane's `agy` agent (`--agent`, and its folder under `~/.gemini/config/agents/`). */
export function antigravityAgentName(bot: Pick<Bot, 'slug'>, key: LaneKey): string {
  return `milibot-${bot.slug}${laneSuffix(key)}`
}

/**
 * An `agent.md` for `--agent`: `agy` replaces its own system prompt with the body and offers only the listed
 * native tools. Lanes keep MCP (the global config: Milibot's bridge) and customizations (repo rules, skills);
 * one-shot calls get neither.
 */
export function antigravityAgentFile(
  name: string,
  tools: readonly string[],
  prompt: string,
  options: { lane: boolean } = { lane: true },
): string {
  return [
    '---',
    `name: ${name}`,
    'description: Milibot bot',
    'mainAgent: true',
    `inheritCustomizations: ${options.lane}`,
    `inheritMcp: ${options.lane}`,
    ...(tools.length ? ['tools:', ...tools.map((t) => `  - ${t}`)] : ['tools: []']),
    '---',
    '',
    prompt.trimStart().startsWith('# ') ? prompt : `# Milibot\n\n${prompt}`,
    '',
  ].join('\n')
}

/**
 * The MCP tools of a lane with their schemas, for its agent prompt: under `--agent`, `agy` gives the model the
 * MCP tools' names but never their schemas (its schema files are not written, and any other agy process empties
 * them). External tools are named as the bridge exposes them (`<slug>__<tool>`).
 */
export function antigravityToolsPrompt(
  milibot: readonly ToolDefinition[],
  external: CliMcpConfig['servers'] | null,
): string {
  const externalTools = Object.entries(external ?? {}).flatMap(([slug, server]) =>
    ((server.tools ?? []) as ToolDefinition[]).map((t) => ({ ...t, name: `${slug}__${t.name}` })),
  )
  const tools = [...milibot, ...externalTools]
  if (!tools.length) return ''
  return [
    '# MCP tools',
    '',
    `Call these with call_mcp_tool: ServerName "${MILIBOT_MCP_SERVER}", ToolName exactly as written below, Arguments an object that follows the tool's schema. Every schema is here: never look for schema files.`,
    ...tools.flatMap((t) => [
      '',
      `## ${t.name}`,
      t.description.trim(),
      `Arguments: ${JSON.stringify(t.inputSchema)}`,
    ]),
  ].join('\n')
}
