import type { ProviderType } from '@milibot/shared'

type ImageMediaType = 'image/png' | 'image/jpeg'

export type ContentPart =
  /** `cacheBreakpoint` marks the end of a stable prefix (system parts): providers cache up to it. */
  | { type: 'text'; text: string; cacheBreakpoint?: boolean }
  /** Images are stored on disk addressed by hash; providers load them when building the request. */
  | {
      type: 'image'
      sha256: string
      mediaType: ImageMediaType
      width: number
      height: number
      /** Text that replaces the image when it leaves the context (default: the screenshot note). */
      placeholder?: string
    }

/** The text parts joined (images skipped). */
export function textOfParts(parts: ContentPart[], separator = ''): string {
  return parts
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join(separator)
}

/**
 * The non-empty text parts of the system messages, each marked when a cache breakpoint ends there: the
 * parts flagged `cacheBreakpoint`, or the last part when none is flagged.
 */
export function systemCacheParts(messages: ChatMessage[]): Array<{ text: string; breakpoint: boolean }> {
  const parts = messages
    .filter((m) => m.role === 'system')
    .flatMap((m) => m.content)
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text' && p.text.length > 0)
  const flagged = parts.some((p) => p.cacheBreakpoint)
  return parts.map((p, i) => ({
    text: p.text,
    breakpoint: Boolean(flagged ? p.cacheBreakpoint : i === parts.length - 1),
  }))
}

export interface ToolCall {
  id: string
  name: string
  arguments: unknown
}

export type AssistantMessage = {
  role: 'assistant'
  content: ContentPart[]
  toolCalls?: ToolCall[]
  /**
   * Provider-native representation (e.g. Anthropic content blocks with thinking signatures), replayed
   * verbatim when the same provider type continues the conversation.
   */
  providerData?: { type: ProviderType; content: unknown }
}

export type ChatMessage =
  | { role: 'system'; content: ContentPart[] }
  | { role: 'user'; content: ContentPart[] }
  | AssistantMessage
  | { role: 'tool'; toolCallId: string; toolName: string; content: ContentPart[]; isError?: boolean }
