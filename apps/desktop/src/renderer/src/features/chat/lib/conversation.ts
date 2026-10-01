import type { Bot, BotStatus, ConversationSummary } from '@milibot/shared'

export interface ConversationDisplay {
  title: string
  label: string | null
  members: Bot[]
  primaryBot: Bot | null
  status: BotStatus | null
}

export function describeConversation(
  conversation: ConversationSummary,
  bots: Record<string, Bot>,
  groupFallback: string,
): ConversationDisplay {
  const members = conversation.memberBotIds.map((id) => bots[id]).filter((b): b is Bot => Boolean(b))
  if (conversation.type === 'direct') {
    const bot = members[0] ?? null
    return {
      title: bot?.name ?? '…',
      label: bot?.label || null,
      members,
      primaryBot: bot,
      status: bot?.status ?? null,
    }
  }
  const busy = members.find((b) => b.status !== 'idle')
  return {
    title: conversation.title || members.map((b) => b.name).join(', ') || groupFallback,
    label: null,
    members,
    primaryBot: null,
    status: busy?.status ?? null,
  }
}

export const STATUS_TEXT_CLASS: Record<string, string> = {
  idle: 'text-fg-muted',
  thinking: 'text-accent',
  working: 'text-success',
  talking: 'text-accent',
  paused: 'text-warning',
  effort: 'text-warning',
}

export const STATUS_DOT_CLASS: Record<string, string> = {
  idle: 'bg-fg-muted',
  thinking: 'bg-accent',
  working: 'bg-success',
  talking: 'bg-accent',
  paused: 'bg-warning',
  effort: 'bg-warning',
}

export function matchesSearch(display: ConversationDisplay, search: string): boolean {
  const q = search.trim().toLocaleLowerCase()
  if (!q) return true
  return [display.title, display.label ?? '', ...display.members.map((m) => m.name)].some((s) =>
    s.toLocaleLowerCase().includes(q),
  )
}
