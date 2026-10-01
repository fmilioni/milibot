import { createHash } from 'node:crypto'

/** Provider limit for tool names (OpenAI and Anthropic: `^[a-zA-Z0-9_-]{1,64}$`). */
const MAX_TOOL_NAME = 64
/** Server key of Milibot's own tools inside the CLI engines; never used by an external server. */
export const MILIBOT_MCP_SERVER = 'milibot'
export const RESERVED_MCP_SLUGS: ReadonlySet<string> = new Set([MILIBOT_MCP_SERVER])

/** `mcp__milibot__computer` → `computer`; null for native Claude Code tools. */
export function milibotToolName(name: string): string | null {
  const prefix = `mcp__${MILIBOT_MCP_SERVER}__`
  return name.startsWith(prefix) ? name.slice(prefix.length) : null
}

/**
 * Server key used in tool names: lowercase letters, digits and `-`, single `_` between words, so
 * `mcp__<slug>__<tool>` splits unambiguously. Claude Code keeps such names as they are.
 */
export function mcpServerSlug(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, 24)
    .replace(/[_-]+$/g, '')
  return slug || 'server'
}

/** Tool name as Claude Code writes it (`normalizeNameForMCP`): anything outside `[A-Za-z0-9_-]` becomes `_`. */
export function normalizeMcpToolName(tool: string): string {
  return tool.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/**
 * Namespaced tool name `mcp__<server>__<tool>`. Names over the provider limit keep a prefix and get a
 * short hash of the full name so two long tools of the same server never collide.
 */
export function mcpToolName(serverSlug: string, tool: string): string {
  const full = `mcp__${serverSlug}__${normalizeMcpToolName(tool)}`
  if (full.length <= MAX_TOOL_NAME) return full
  const hash = createHash('sha256').update(full).digest('hex').slice(0, 8)
  return `${full.slice(0, MAX_TOOL_NAME - 9)}_${hash}`
}

/** Splits `mcp__<server>__<tool>`; the tool part is the normalized (possibly shortened) name. */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  const match = /^mcp__([a-z0-9-]+(?:_[a-z0-9-]+)*)__(.+)$/.exec(name)
  if (!match) return null
  return { server: match[1] as string, tool: match[2] as string }
}
