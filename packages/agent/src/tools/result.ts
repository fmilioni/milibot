import type { ToolResult } from '../environment'

/** Arguments the model got wrong: reported back to it as `Invalid input: …` so it can fix the call. */
export class ToolInputError extends Error {
  override readonly name = 'ToolInputError'
}

export function toolText(value: string, isError = false, activity?: ToolResult['activity']): ToolResult {
  return {
    content: [{ type: 'text', text: value }],
    ...(isError ? { isError: true } : {}),
    ...(activity ? { activity } : {}),
  }
}

export function toolError(value: string, activity?: ToolResult['activity']): ToolResult {
  return toolText(value, true, activity)
}
