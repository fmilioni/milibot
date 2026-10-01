import { clipLine } from '@milibot/shared'

import type { CliToolView } from '../cli/tools'
import { mcpToolName, MILIBOT_MCP_SERVER } from '../mcp/names'
import { argsObject } from '../tools/args'
import { type DescribeOptions, isNoopCommand } from '../tools/describe'
import type { AgyToolInfo } from './stream-json'

/** Prefix of `agy`'s own tool calls in `tool_calls` (its names would clash with Milibot's otherwise). */
const AGY_TOOL_PREFIX = 'agy.'

/** Names `agy`'s own tool calls get in `tool_calls`. */
export const ANTIGRAVITY_TOOLS = {
  command: 'agy.run_command',
  write: 'agy.write_to_file',
  replace: 'agy.replace_file_content',
  multiReplace: 'agy.multi_replace_file_content',
  sed: 'agy.sed_file',
  notebook: 'agy.notebook_edit',
} as const

/** Native tools a chat lane keeps (`agent.md` `tools`); the rest of `agy`'s set has a Milibot counterpart. */
export const ANTIGRAVITY_LANE_TOOLS = [
  'run_command',
  'manage_task',
  'view_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'list_dir',
  'search_web',
  'read_url_content',
] as const

/** Work sessions search many files: the search tools save shell round trips there. */
export const ANTIGRAVITY_SESSION_TOOLS = [...ANTIGRAVITY_LANE_TOOLS, 'grep_search', 'find_by_name'] as const

/** Read-only helpers: look things up, change nothing. */
export const ANTIGRAVITY_READ_ONLY_TOOLS = [
  'run_command',
  'view_file',
  'list_dir',
  'grep_search',
  'find_by_name',
  'search_web',
  'read_url_content',
] as const

/** Shown as nothing: they only steer `agy`'s own background tasks. */
const HIDDEN = new Set(['command_status', 'send_command_input', 'manage_task'])

function field(input: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

/**
 * What a call of `agy`'s own tools is logged as: its name with the `agy.` prefix, and a shell command as
 * `{command}` like every other shell tool (what Milibot reads to spot `gh pr` calls).
 */
export function antigravityToolCall(tool: AgyToolInfo): { name: string; input: Record<string, unknown> } {
  if (tool.name === 'run_command') {
    const command = field(tool.parameters, 'CommandLine', 'Command')
    const cwd = field(tool.parameters, 'Cwd')
    return { name: ANTIGRAVITY_TOOLS.command, input: { command, ...(cwd ? { cwd } : {}) } }
  }
  return { name: `${AGY_TOOL_PREFIX}${tool.name}`, input: tool.parameters }
}

/**
 * An MCP call (`call_mcp_tool`) as Milibot names it. Every server reaches `agy` through the bridge registered
 * as Milibot's server: Milibot's own tools keep their names (`milibot: true`, logged by Milibot's MCP server),
 * an external server's arrive as `<slug>__<tool>` and become `mcp__<slug>__<tool>`.
 */
export function antigravityMcpCall(
  tool: AgyToolInfo,
): { milibot: true } | { milibot: false; name: string; input: unknown } | null {
  if (tool.name !== 'call_mcp_tool') return null
  const server = field(tool.parameters, 'ServerName')
  const name = field(tool.parameters, 'ToolName')
  const input = tool.parameters.Arguments ?? {}
  const split = name.indexOf('__')
  if (server === MILIBOT_MCP_SERVER && split < 0) return { milibot: true }
  if (server === MILIBOT_MCP_SERVER)
    return { milibot: false, name: mcpToolName(name.slice(0, split), name.slice(split + 2)), input }
  return { milibot: false, name: mcpToolName(server || 'mcp', name), input }
}

/** Activity step (`kind` + human detail) of one of `agy`'s own tool calls, or hidden; null for other names. */
export function describeAntigravityTool(
  name: string,
  input: unknown,
  options: DescribeOptions = {},
): CliToolView | null {
  if (!name.startsWith(AGY_TOOL_PREFIX)) return null
  const tool = name.slice(AGY_TOOL_PREFIX.length)
  if (HIDDEN.has(tool)) return { hidden: true }
  const clip = options.full ? (text: string, _max?: number) => text.trim() : clipLine
  const a = argsObject(input)
  switch (tool) {
    case 'run_command': {
      const command = field(a, 'command', 'CommandLine')
      return isNoopCommand(command)
        ? { hidden: true }
        : { hidden: false, kind: 'bash', detail: clip(command, 80) }
    }
    case 'view_file':
      return { hidden: false, kind: 'file_read', detail: field(a, 'AbsolutePath', 'TargetFile', 'Path') }
    case 'write_to_file':
      return { hidden: false, kind: 'file_write', detail: field(a, 'TargetFile', 'AbsolutePath') }
    case 'replace_file_content':
    case 'multi_replace_file_content':
    case 'sed_file':
    case 'notebook_edit':
      return {
        hidden: false,
        kind: 'file_edit',
        detail: field(a, 'TargetFile', 'AbsolutePath', 'NotebookPath'),
      }
    case 'list_dir':
      return { hidden: false, kind: 'file_list', detail: field(a, 'DirectoryPath', 'Path') || '.' }
    case 'find_by_name': {
      const where = field(a, 'SearchDirectory', 'Path')
      const pattern = field(a, 'Pattern', 'Query')
      return { hidden: false, kind: 'file_list', detail: where ? `${pattern} in ${where}` : pattern }
    }
    case 'grep_search': {
      const where = field(a, 'SearchPath', 'Path')
      const query = clip(field(a, 'Query', 'Pattern'), 60)
      return { hidden: false, kind: 'search', detail: where ? `${query} in ${where}` : query }
    }
    case 'search_web':
      return { hidden: false, kind: 'web_search', detail: clip(field(a, 'query', 'Query'), 80) }
    case 'read_url_content':
      return { hidden: false, kind: 'web_fetch', detail: field(a, 'Url', 'url') }
    default:
      return { hidden: false, kind: 'tool', detail: tool }
  }
}
