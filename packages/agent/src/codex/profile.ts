import { createHash } from 'node:crypto'

import type { CliProfileInput } from '../cli/engine'

/** Estimated tokens of Codex's own instructions + native tools, before a thread measures them. */
export const ESTIMATED_CODEX_BASE_TOKENS = 9_000

/**
 * Identifies what a thread was started with: Milibot's developer instructions, its MCP tool docs and the
 * external MCP servers (without secret values). Codex keeps a thread's developer instructions; memory is left
 * out (it reaches a resumed thread in its input).
 */
export function codexProfile(input: CliProfileInput): string {
  const source = JSON.stringify([
    input.instructions,
    input.mcpTools,
    ...(input.externalFingerprint ? [input.externalFingerprint] : []),
  ])
  return createHash('sha256').update(source).digest('hex').slice(0, 12)
}
