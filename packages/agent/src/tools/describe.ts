import { clipLine } from '@milibot/shared'

import { parseMcpToolName } from '../mcp/names'
import { argsObject } from './args'
import { TOOL_CATALOG } from './catalog'
import type { StepView, ToolStep } from './families/kit'

export { describeSecretRefs, type ToolStep } from './families/kit'

export interface DescribeOptions {
  /** Whole detail (commands, typed text…) instead of one clipped line, for expanded views. */
  full?: boolean
  /** Display name of an external MCP server by its slug ("GitHub" for `github`). */
  mcpServerName?: (slug: string) => string | null | undefined
}

/** Shell commands that do nothing (`true`, `:`, an empty line): tool calls with them are not shown. */
export function isNoopCommand(command: unknown): boolean {
  if (typeof command !== 'string') return true
  return /^(true|:|exit( 0)?|echo( "")?|sleep 0)?\s*;?$/.test(command.trim())
}

/** Tool calls that mean nothing to the user: logged, but never shown as activity steps. */
export function isNoopToolCall(name: string, args: unknown): boolean {
  if (name !== 'bash') return false
  return isNoopCommand((args as { command?: unknown } | null)?.command)
}

/** Stable `kind` (icon/i18n key) + short human detail for the activity card. */
export function describeToolCall(name: string, args: unknown, options: DescribeOptions = {}): ToolStep {
  const view: StepView = options.full
    ? { full: true, clip: (text) => text.trim() }
    : { full: false, clip: (text, max = 80) => clipLine(text, max) }
  for (const family of TOOL_CATALOG)
    if (family.has(name)) return (family.describe as DescribeAny)(name, argsObject(args), view)
  const external = parseMcpToolName(name)
  if (external) {
    const server = options.mcpServerName?.(external.server) || external.server
    return { kind: 'mcp', detail: `${server} · ${external.tool}` }
  }
  // Never raw arguments: the app shows the tool's own text (or its name) without a detail.
  return { kind: name, detail: '' }
}

type DescribeAny = (name: string, args: Record<string, unknown>, view: StepView) => ToolStep

const STEP_LABELS: Readonly<Record<string, string>> = Object.assign(
  {},
  ...TOOL_CATALOG.map((family) => family.labels),
)

/** Plain-text line of an activity step (message `content` fallback: previews, search, copy). */
export function activityLine(kind: string, detail: string): string {
  const label = STEP_LABELS[kind] ?? kind.replace(/_/g, ' ')
  return detail ? `${label}: ${detail}` : label
}
