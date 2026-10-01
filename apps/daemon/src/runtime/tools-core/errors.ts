import type { ToolResult } from '@milibot/agent'
import { toolError, ToolInputError } from '@milibot/agent/tools'

import { DaemonError } from '../../errors'
import { GuestError } from '../vm'

export function unknownTool(name: string): ToolResult {
  return toolError(`Unknown tool "${name}"`)
}

/**
 * The result the bot sees for an error a tool threw: input errors (also zod's) as `Invalid input: …`, errors the
 * daemon raises on purpose as their message. A stopped turn and anything unexpected are rethrown.
 */
export function toolErrorResult(err: unknown, signal: AbortSignal): ToolResult {
  if (signal.aborted) throw err
  if (err instanceof ToolInputError || (err instanceof Error && 'issues' in err))
    return toolError(`Invalid input: ${err.message}`)
  if (err instanceof GuestError) return toolError(`VM error (${err.code}): ${err.message}`)
  if (err instanceof DaemonError) return toolError(err.message)
  throw err
}

/** The error a waiting tool throws when the turn is stopped. */
export function stopped(): Error {
  return Object.assign(new Error('turn stopped'), { name: 'AbortError' })
}
