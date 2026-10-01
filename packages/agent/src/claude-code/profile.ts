import { createHash } from 'node:crypto'

import type { CliProfileInput } from '../cli/engine'

/**
 * Built-in Claude Code tools the bots get. Everything else in the default set (subagents, task
 * lists, cron/wakeups, worktrees, notebooks, workflows, push notifications…) is either unused by
 * bots or replaced by a Milibot tool, and all of it is resent on every request: measured with
 * haiku, the default set costs ~29k tokens per request against ~6k for these six.
 */
export const CLAUDE_CODE_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'WebFetch', 'WebSearch'] as const

/** Work sessions search and change many files: Glob/Grep save shell round trips there. */
export const CLAUDE_CODE_SESSION_TOOLS = [
  'Bash',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
] as const

/** Read-only helpers: look things up, change nothing. */
export const CLAUDE_CODE_READ_ONLY_TOOLS = ['Bash', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'] as const

/** Estimated tokens of Claude Code's own system prompt + native tools, before a session measures it. */
export const ESTIMATED_BASE_TOKENS = { compact: 7_000, default: 12_700 } as const

/**
 * Identifies what a session was started with: tool set, Claude Code system prompt, Milibot's
 * `--append-system-prompt-file` (rules + persona + team + skills catalog), MCP tool docs and the external MCP
 * servers (without secret values). Claude Code snapshots the system prompt per session, so a resumed session
 * would keep the old one. The memory bootstrap is left out on purpose: memory changes reach a resumed session
 * as a note before its next input.
 */
export function claudeCodeProfile(input: CliProfileInput): string {
  const source = JSON.stringify([
    input.nativeTools ?? CLAUDE_CODE_TOOLS,
    input.settings.systemPrompt,
    input.instructions,
    input.mcpTools,
    ...(input.externalFingerprint ? [input.externalFingerprint] : []),
  ])
  return createHash('sha256').update(source).digest('hex').slice(0, 12)
}
