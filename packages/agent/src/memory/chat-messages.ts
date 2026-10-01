import type { Bot, Message, RoutineRunPayload, UserMessagePayload } from '@milibot/shared'

import type { ChatMessage, ContentPart } from '../llm/messages'

const KEEP_SCREENSHOTS = 2
export const OMITTED_SCREENSHOT = '[older screenshot omitted to save context]'
/** Tool outputs above this are cut (head + tail kept) before entering the context. */
export const MAX_TOOL_OUTPUT_CHARS = 12_000

/** A routine run: its instructions reach the bot as a user message, in that run and in the history. */
export function isRoutineRun(message: Message): message is Message & { payload: RoutineRunPayload } {
  return message.kind === 'card' && message.payload?.type === 'routine_run'
}

const INSTRUCTION_CARDS = new Set(['routine_run', 'session_brief', 'work_session'])

/**
 * Cards whose text the bot reads as a user message, in their turn and in the history: its routine runs,
 * the brief of its work session and the card of a work session it started (its result once finished).
 */
export function isInstructionCard(message: Message): boolean {
  return message.kind === 'card' && INSTRUCTION_CARDS.has(message.payload?.type ?? '')
}

/** The text `bot` reads from an instruction card (null: another bot's card, or not one). */
export function instructionText(message: Message, bot: Bot): string | null {
  if (!isInstructionCard(message)) return null
  const owner = (message.payload as { botId?: string } | null)?.botId
  return owner === bot.id && message.content.trim() ? message.content : null
}

/** One stored chat message as seen by `bot` (null when it is not part of the model's context). */
export function messageToChat(message: Message, bot: Bot, botsById: Map<string, Bot>): ChatMessage | null {
  if (isInstructionCard(message)) {
    const text = instructionText(message, bot)
    return text ? { role: 'user', content: [{ type: 'text', text }] } : null
  }
  if (message.kind !== 'text' || !message.content.trim()) return null
  if (message.payload?.type === 'text' && message.payload.streaming) return null
  if (message.authorType === 'user') {
    const content: ContentPart[] = [{ type: 'text', text: message.content }]
    if (message.payload?.type === 'user_message') content.push(...attachmentImages(message.payload))
    return { role: 'user', content }
  }
  if (message.authorType !== 'bot') return null
  if (message.authorBotId === bot.id)
    return { role: 'assistant', content: [{ type: 'text', text: message.content }] }
  const name = botsById.get(message.authorBotId ?? '')?.name ?? 'Another bot'
  return { role: 'user', content: [{ type: 'text', text: `[${name}]: ${message.content}` }] }
}

/**
 * Attached PNG/JPEG files as image inputs (their paths are already in the text). They count against
 * the same budget as screenshots (`pruneScreenshots`).
 */
function attachmentImages(payload: UserMessagePayload): ContentPart[] {
  return payload.attachments.flatMap((a): ContentPart[] =>
    a.image && a.status !== 'failed'
      ? [
          {
            type: 'image',
            sha256: a.image.sha256,
            mediaType: a.image.mediaType,
            width: a.image.width,
            height: a.image.height,
            placeholder: `[image ${a.path} omitted to save context; read the file if you need it again]`,
          },
        ]
      : [],
  )
}

/** Replaces all but the `keep` most recent images with a text placeholder (in place). */
export function pruneScreenshots(messages: ChatMessage[], keep = KEEP_SCREENSHOTS): void {
  let seen = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as ChatMessage
    for (let j = message.content.length - 1; j >= 0; j--) {
      const part = message.content[j]
      if (part?.type !== 'image') continue
      seen++
      if (seen > keep) message.content[j] = { type: 'text', text: part.placeholder ?? OMITTED_SCREENSHOT }
    }
  }
}

/** Cuts the middle of long text outputs once, when they enter the context (keeps the prefix byte-stable). */
export function truncateToolContent(parts: ContentPart[], maxChars = MAX_TOOL_OUTPUT_CHARS): ContentPart[] {
  return parts.map((p) => {
    if (p.type !== 'text' || p.text.length <= maxChars) return p
    const head = Math.floor(maxChars * 0.7)
    const tail = maxChars - head
    const omitted = p.text.length - head - tail
    return {
      type: 'text',
      text: `${p.text.slice(0, head)}\n[… ${omitted} characters of output omitted …]\n${p.text.slice(-tail)}`,
    }
  })
}
