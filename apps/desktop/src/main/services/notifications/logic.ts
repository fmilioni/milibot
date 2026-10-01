import { CLI_ENGINE_INFO, cliErrorOf, type Language, type WorkspaceEvent } from '@milibot/shared'

import { type MainStringKey, mainText } from '../../app/i18n'

/**
 * `reply`: a bot finished a turn the user started; `attention`: a bot needs the user (confirmation,
 * prompt approval, a plan to approve, a password or a question, CLI login, spend limit, crashed turn);
 * `routine`: a routine run ended.
 */
type NotifyKind = 'reply' | 'attention' | 'routine'

export interface NotifyCandidate {
  kind: NotifyKind
  workspaceId: string
  conversationId: string
  /** Null for workspace-wide news (the spend limit), which the bot switch does not mute. */
  botId: string | null
  /** `routine`: `done` or `failed`. */
  reason: string
  title: string
  body: string
}

export interface NotifyPreferences {
  enabled: boolean
  mutedBots: ReadonlySet<string>
  routines: 'always' | 'attention'
}

export interface WorkspaceFocus {
  /** A window of the workspace is the focused window on the desktop. */
  focused: boolean
  /** Conversation on screen in that focused window. */
  conversationId: string | null
}

export function shouldNotify(
  candidate: NotifyCandidate,
  preferences: NotifyPreferences,
  focus: WorkspaceFocus,
): boolean {
  if (!preferences.enabled) return false
  if (candidate.botId && preferences.mutedBots.has(candidate.botId)) return false
  if (focus.focused && focus.conversationId === candidate.conversationId) return false
  switch (candidate.kind) {
    case 'reply':
      return !focus.focused
    case 'attention':
      return true
    case 'routine':
      return candidate.reason === 'failed' || preferences.routines === 'always'
  }
}

const BODY_MAX = 180

/** First non-empty line of a reply as plain text (markdown markers dropped), cut for the banner. */
export function firstLine(text: string): string {
  const line =
    text
      .replace(/```[\s\S]*?(```|$)/g, ' ')
      .split('\n')
      .map((l) =>
        l
          .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '')
          .replace(/(\*\*|__|~~|`)/g, '')
          .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
          .trim(),
      )
      .find(Boolean) ?? ''
  return line.length > BODY_MAX ? `${line.slice(0, BODY_MAX - 1)}…` : line
}

export interface ClassifyContext {
  workspaceId: string
  language: Language
  botName(botId: string): string | null
  /** Title of news that is not about one bot. */
  workspaceName: string
}

const REPLY_TRIGGERS = new Set(['user_message', 'session_finished', 'after_current_work', 'routine'])

/** Cheap pre-filter: events `classifyEvent` may turn into a notification (the rest never loads bot names). */
export function isNotificationCandidate(event: WorkspaceEvent): boolean {
  if (event.type === 'turn.finished') return REPLY_TRIGGERS.has(event.payload.trigger)
  return event.type === 'message.created' && event.payload.message.kind === 'card'
}

/** The notification a workspace event may raise (before preferences, focus and grouping). */
export function classifyEvent(event: WorkspaceEvent, ctx: ClassifyContext): NotifyCandidate | null {
  const text = (key: MainStringKey, params: Record<string, string> = {}) =>
    mainText(ctx.language, key, params)
  const base = { workspaceId: ctx.workspaceId }
  if (event.type === 'turn.finished') {
    const { botId, conversationId, trigger, outcome, reply, routine } = event.payload
    const title = ctx.botName(botId) ?? ctx.workspaceName
    if (trigger === 'routine' && outcome !== 'cancelled') {
      const name = routine?.name ?? ''
      const head = text(outcome === 'done' ? 'notifyRoutineDone' : 'notifyRoutineFailed', { routine: name })
      const line = outcome === 'done' ? firstLine(reply) : ''
      return {
        ...base,
        kind: 'routine',
        conversationId,
        botId,
        reason: outcome === 'done' ? 'done' : 'failed',
        title,
        body: line ? `${head}: ${line}` : head,
      }
    }
    if (
      (trigger === 'user_message' || trigger === 'session_finished' || trigger === 'after_current_work') &&
      outcome === 'done'
    ) {
      return {
        ...base,
        kind: 'reply',
        conversationId,
        botId,
        reason: 'reply',
        title,
        body: firstLine(reply) || text('notifyReplyEmpty'),
      }
    }
    return null
  }
  if (event.type !== 'message.created') return null
  const { message } = event.payload
  const payload = message.payload
  if (message.kind !== 'card' || !payload) return null
  const botId = message.authorBotId
  const title = (botId && ctx.botName(botId)) || ctx.workspaceName
  const attention = (reason: string, body: string, owner: string | null = botId): NotifyCandidate => ({
    ...base,
    kind: 'attention',
    conversationId: message.conversationId,
    botId: owner,
    reason,
    title: owner ? title : ctx.workspaceName,
    body,
  })
  switch (payload.type) {
    case 'confirmation':
      if (payload.status !== 'pending') return null
      if (payload.action === 'update_prompt')
        return attention(
          'prompt_approval',
          text('notifyPromptApproval', { botName: payload.params?.botName ?? '' }),
        )
      return attention(
        'confirmation',
        payload.description.trim()
          ? text('notifyConfirmation', { reason: firstLine(payload.description) })
          : text('notifyConfirmationShort'),
      )
    case 'error': {
      const cli = cliErrorOf(payload.code, payload.params)
      if (cli?.code === 'cli_login_required')
        return attention(
          'login_required',
          text('notifyCliLoginRequired', { engine: CLI_ENGINE_INFO[cli.engine].displayName }),
        )
      if (payload.code === 'turn_crashed') return attention('turn_crashed', text('notifyTurnCrashed'))
      return null
    }
    case 'secret_request':
      if (payload.status !== 'pending') return null
      return attention(
        'secret_request',
        text(payload.asEnv ? 'notifySecretEnvRequest' : 'notifySecretRequest', { label: payload.label }),
      )
    case 'question': {
      if (payload.status !== 'pending') return null
      const question = firstLine(payload.questions[0]?.question ?? '')
      return attention(
        'question',
        payload.questions.length > 1
          ? text('notifyQuestions', { count: String(payload.questions.length), question })
          : text('notifyQuestion', { question }),
      )
    }
    case 'plan':
      if (payload.status !== 'awaiting_approval' || payload.removed) return null
      return attention('plan_approval', text('notifyPlanApproval', { title: firstLine(payload.title) }))
    case 'spend_warning':
      return payload.paused ? attention('spend_paused', text('notifySpendPaused'), null) : null
    default:
      return null
  }
}

export interface GroupedNotification {
  title: string
  body: string
  workspaceId: string
  conversationId: string
}

const GROUP_LINES = 3

/**
 * Near-simultaneous notifications become one: what needs the user comes first, and an attention
 * card replaces the plain "finished" of the same bot and conversation (a crashed turn also ends).
 */
export function groupNotifications(items: NotifyCandidate[], language: Language): GroupedNotification[] {
  const key = (c: NotifyCandidate) => `${c.workspaceId}:${c.conversationId}:${c.botId ?? ''}`
  const needsUser = new Set(items.filter((c) => c.kind === 'attention').map(key))
  const seen = new Set<string>()
  const kept: NotifyCandidate[] = []
  for (const item of items) {
    if (item.kind !== 'attention' && needsUser.has(key(item))) continue
    const id = `${key(item)}:${item.kind}:${item.reason}:${item.body}`
    if (seen.has(id)) continue
    seen.add(id)
    kept.push(item)
  }
  kept.sort((a, b) => Number(b.kind === 'attention') - Number(a.kind === 'attention'))
  const [first] = kept
  if (!first) return []
  const target = { workspaceId: first.workspaceId, conversationId: first.conversationId }
  if (kept.length === 1) return [{ title: first.title, body: first.body, ...target }]
  const sameSender = kept.every((c) => c.title === first.title)
  const lines = kept.slice(0, GROUP_LINES).map((c) => (sameSender ? c.body : `${c.title}: ${c.body}`))
  if (kept.length > GROUP_LINES)
    lines.push(mainText(language, 'notifyGroupMore', { count: kept.length - GROUP_LINES }))
  return [
    {
      title: sameSender ? first.title : mainText(language, 'notifyGroupTitle', { count: kept.length }),
      body: lines.join('\n'),
      ...target,
    },
  ]
}
