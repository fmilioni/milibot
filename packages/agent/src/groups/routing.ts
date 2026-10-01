import {
  type Bot,
  type ConversationSummary,
  groupSettings,
  type Message,
  parseMentions,
} from '@milibot/shared'

export const DEFAULT_BOT_COOLDOWN_SECONDS = 20

export interface RoutePlan {
  /** Mentioned bots: they take a turn right away. */
  enqueue: string[]
  /** Bots the triage model decides about. */
  triage: string[]
  /** Why nobody is woken (debug). */
  skipped?: 'bot_streak_limit' | 'no_members'
}

/** Bot text messages in a row at the end of `messages` (since the last user message). */
export function botStreak(messages: Message[]): number {
  let streak = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Message
    if (m.authorType === 'user') break
    if (m.authorType === 'bot' && m.kind === 'text' && m.content.trim()) streak++
  }
  return streak
}

/**
 * Who reacts to a new group message. Mentioned members answer; the others go through triage when
 * the group answers without mentions. Messages from bots are guarded against loops: nobody answers
 * once `maxConsecutiveBotMessages` bot messages came in a row, only mentions count when the streak
 * is near the limit, and bots that spoke in the group recently (cooldown) are not triaged.
 */
export function planGroupRoute(input: {
  message: Message
  conversation: ConversationSummary
  bots: Map<string, Bot>
  /** Recent messages of the conversation, including `message`. */
  recent: Message[]
  now: number
  lastSpokeAt: (botId: string) => number | null
  cooldownMs: number
}): RoutePlan {
  const { message, conversation, bots } = input
  const settings = groupSettings(conversation)
  const members = conversation.memberBotIds
    .map((id) => bots.get(id))
    .filter((b): b is Bot => b !== undefined && b.id !== message.authorBotId)
  if (members.length === 0) return { enqueue: [], triage: [], skipped: 'no_members' }
  const mentioned = parseMentions(message.content, members)
  const rest = members.filter((b) => !mentioned.includes(b.id)).map((b) => b.id)

  if (message.authorType !== 'bot') {
    if (mentioned.length === 0 && members.length === 1 && settings.respondWithoutMention)
      return { enqueue: rest, triage: [] }
    return { enqueue: mentioned, triage: settings.respondWithoutMention ? rest : [] }
  }

  const streak = botStreak(input.recent)
  const max = settings.maxConsecutiveBotMessages
  if (streak >= max) return { enqueue: [], triage: [], skipped: 'bot_streak_limit' }
  if (!settings.respondWithoutMention || streak >= max - 2) return { enqueue: mentioned, triage: [] }
  const rested = rest.filter((id) => {
    const at = input.lastSpokeAt(id)
    return at === null || input.now - at >= input.cooldownMs
  })
  return { enqueue: mentioned, triage: rested }
}

/** Bot ids chosen by the triage model (slugs, names or ids), or null when the answer is unusable. */
export function parseTriageResponse(text: string, candidates: Bot[]): string[] | null {
  const match = /\{[\s\S]*\}/.exec(text)
  if (!match) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch {
    return null
  }
  const respond = (parsed as { respond?: unknown }).respond
  if (!Array.isArray(respond)) return null
  const ids = new Set<string>()
  for (const item of respond) {
    if (typeof item !== 'string') continue
    const key = item.trim().replace(/^@/, '').toLowerCase()
    const bot = candidates.find((b) => b.slug === key || b.id === item || b.name.toLowerCase() === key)
    if (bot) ids.add(bot.id)
  }
  return candidates.filter((b) => ids.has(b.id)).map((b) => b.id)
}
