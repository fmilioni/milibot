import type { ContextComposition } from '@milibot/shared'
import { estimateTokens } from '@milibot/shared'

import type { ChatMessage, ContentPart } from '../llm/messages'
import type { ToolDefinition } from '../llm/provider'

/** Anthropic's (width*height)/750 rule. */
export function imageTokens(width: number, height: number): number {
  return Math.min(1600, Math.ceil((Math.max(1, width) * Math.max(1, height)) / 750))
}

function partsTokens(parts: ContentPart[]): number {
  return parts.reduce(
    (sum, p) => sum + (p.type === 'text' ? estimateTokens(p.text) : imageTokens(p.width, p.height)),
    0,
  )
}

export function messageTokens(message: ChatMessage): number {
  let tokens = partsTokens(message.content) + 4
  if (message.role === 'assistant') {
    for (const call of message.toolCalls ?? [])
      tokens += estimateTokens(JSON.stringify(call.arguments ?? {})) + 10
  }
  return tokens
}

export function messagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + messageTokens(m), 0)
}

/** Tokens and count of the images of a conversation (screenshots left after pruning). */
export function imagesTokens(messages: ChatMessage[]): { tokens: number; count: number } {
  let tokens = 0
  let count = 0
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type !== 'image') continue
      tokens += imageTokens(part.width, part.height)
      count++
    }
  }
  return { tokens, count }
}

export function composition(
  systemPrompt: string,
  tools: ToolDefinition[],
  conversation: ChatMessage[],
): ContextComposition {
  const images = imagesTokens(conversation)
  return {
    systemPrompt: estimateTokens(systemPrompt),
    longTermMemory: 0,
    summaries: 0,
    retrieved: 0,
    recentTail: Math.max(0, messagesTokens(conversation) - images.tokens),
    tools: estimateTokens(JSON.stringify(tools)),
    ...(images.count ? { images: images.tokens, imageCount: images.count } : {}),
  }
}

/** Keys of `ContextComposition` that break a section down instead of being one. */
const SUB_PARTS = new Set<keyof ContextComposition>(['mcpServers', 'imageCount', 'persona'])

/** Sum of the sections of a composition (sub-parts like `persona` or per-server MCP are inside them). */
export function compositionTotal(composition: ContextComposition): number {
  return (Object.keys(composition) as Array<keyof ContextComposition>)
    .filter((k) => !SUB_PARTS.has(k))
    .reduce((sum, k) => sum + ((composition[k] as number | undefined) ?? 0), 0)
}

/**
 * Scales the estimated sections so they add up to the prompt tokens the provider actually billed
 * (input + cache reads + cache writes); proportions stay estimated, the total becomes exact.
 */
export function calibrateComposition(
  estimate: ContextComposition,
  actualPromptTokens: number,
): ContextComposition {
  type Section = Exclude<keyof ContextComposition, 'mcpServers' | 'imageCount' | 'persona'>
  const keys = (Object.keys(estimate) as Array<keyof ContextComposition>).filter(
    (k): k is Section => !SUB_PARTS.has(k) && estimate[k] !== undefined,
  )
  const value = (k: Section) => estimate[k] ?? 0
  const total = keys.reduce((sum, k) => sum + value(k), 0)
  if (actualPromptTokens <= 0 || total <= 0) return estimate
  const factor = actualPromptTokens / total
  const scaled = { ...estimate }
  let assigned = 0
  let largest: Section = keys[0] as Section
  for (const k of keys) {
    scaled[k] = Math.round(value(k) * factor)
    assigned += scaled[k]
    if (value(k) > value(largest)) largest = k
  }
  scaled[largest] = (scaled[largest] ?? 0) + actualPromptTokens - assigned
  if (estimate.mcpServers) {
    scaled.mcpServers = Object.fromEntries(
      Object.entries(estimate.mcpServers).map(([name, tokens]) => [name, Math.round(tokens * factor)]),
    )
  }
  if (estimate.persona !== undefined) scaled.persona = Math.round(estimate.persona * factor)
  return scaled
}
