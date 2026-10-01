import { type Bot, clipLine, type ConversationSummary, type Message } from '@milibot/shared'

/** Messages shown to the triage model. */
const TRIAGE_HISTORY = 20
const ROLE_CHARS = 300
const MESSAGE_CHARS = 600

export const TRIAGE_SYSTEM_PROMPT = `You route messages in a group chat between a user and AI bots. Each bot has a role. For the latest message, decide which of the listed bots should answer it.

Rules:
- A bot answers only when the message is addressed to it, asks for something in its role, or needs information only it has.
- Prefer the single most relevant bot. Pick several only when the message clearly needs each of them.
- Pick none for small talk between others, acknowledgments ("ok", "thanks"), messages already answered, or messages addressed to someone else (for example an @mention of another member).
- A bot never answers its own message.

Reply with JSON only, no prose: {"respond": ["<slug>", ...]}`

export function buildTriagePrompt(input: {
  conversation: ConversationSummary
  candidates: Bot[]
  bots: Map<string, Bot>
  recent: Message[]
  message: Message
}): string {
  const { conversation, candidates, bots, message } = input
  const name = (m: Message) =>
    m.authorType === 'user' ? 'user' : (bots.get(m.authorBotId ?? '')?.name ?? 'bot')
  const roster = candidates.map(
    (b) =>
      `- ${b.slug}: ${b.name}${b.label ? ` (${b.label})` : ''} — ${clipLine(b.systemPrompt, ROLE_CHARS)}`,
  )
  const others = conversation.memberBotIds
    .filter((id) => !candidates.some((c) => c.id === id))
    .map((id) => bots.get(id)?.name)
    .filter(Boolean)
  const history = input.recent
    .filter((m) => m.id !== message.id && m.kind === 'text' && m.content.trim())
    .slice(-TRIAGE_HISTORY)
    .map((m) => `[${name(m)}]: ${clipLine(m.content, MESSAGE_CHARS)}`)
  return [
    `Group "${conversation.title ?? 'group'}".`,
    `Bots you decide for:\n${roster.join('\n')}`,
    others.length ? `Other members (already handled): the user, ${others.join(', ')}` : '',
    history.length ? `Recent messages (oldest first):\n${history.join('\n')}` : '',
    `Latest message, from ${name(message)}:\n${clipLine(message.content, 2000)}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}
