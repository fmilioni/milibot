import { type Bot, clipLine, type ConversationSummary } from '@milibot/shared'

// Turn notes ("[Milibot] …") the host adds to a bot's input: plain text from plain data.

export function endedSessionNote(sessionTitle: string): string {
  return `[Milibot] This arrived for your work session "${sessionTitle}", which already ended: handle it here (the session stays closed).`
}

export function botFollowUpNote(botName: string, text: string): string {
  return `[Milibot] ${botName} sent a follow-up in your private conversation, after its earlier answer:\n\n${text}`
}

export function botNoticeNote(botName: string): string {
  return (
    `[Milibot] ${botName} sent this as an update and expects no reply: what you write here is not delivered ` +
    `to ${botName}. Act on it if it concerns your work, then end with one short line. If you need something ` +
    `from ${botName}, use message_bot.`
  )
}

/** An empty `reply` means the bot could not answer. */
export function botReplyNote(botName: string, request: string, reply: string): string {
  const preview = clipLine(request, 120)
  return reply
    ? `[Milibot] ${botName} replied to your message ("${preview}"):\n\n${reply}`
    : `[Milibot] ${botName} could not answer your message ("${preview}"): its turn failed or was stopped.`
}

export function planRequestNote(
  owner: string,
  plan: { id: string; title: string; steps: Array<{ id: string; title: string; status: string }> },
): string {
  return (
    `[Milibot] This request is part of ${owner}'s approved plan "${plan.title}" (plan: "${plan.id}"). ` +
    `Its steps:\n${plan.steps.map((st) => `- [${st.status}] ${st.title} (${st.id})`).join('\n')}\n` +
    'Mark each step you do with plan_step.'
  )
}

/** What a bot's chat turns read about its own work, whichever conversation it started in. */
export interface BotStateLines {
  /** Other lanes running or waiting to run a turn now. */
  running: string[]
  /** Work sessions not ended whose lane has no turn now. */
  openSessions: string[]
  plans: string[]
  setAside: string[]
}

/**
 * The bot's state across all its conversations, read at the start of every chat turn: what an earlier
 * message of this conversation says about its work may be out of date (it ended in another conversation).
 */
export function botStateNote(state: BotStateLines): string {
  const free = state.running.length === 0 && state.openSessions.length === 0
  const lines = [
    '[Milibot] Your state right now, across all your conversations (newer than what earlier messages here say about your work):',
  ]
  const section = (title: string, items: string[]) => {
    if (items.length) lines.push(title, ...items.map((item) => `- ${item}`))
  }
  section(
    'Your other work in progress right now, running on its own beside this conversation:',
    state.running,
  )
  section(
    'Work sessions still open, with no turn running now (waiting for a reply or an answer, or never finished with session_finish):',
    state.openSessions,
  )
  section('Plans not finished:', state.plans)
  section(
    'Requests you set aside, to take up when your current work ends (you are woken with each then):',
    state.setAside,
  )
  lines.push(
    free
      ? 'No other work of yours is running and no work session is open: you are free. Start what is asked here ' +
          'now, in this turn, instead of saying you will do it later.'
      : 'When the user or another bot speaks of what you are doing now, they may mean this work. For something ' +
          'that must wait until it ends, call after_current_work and end your turn: you are woken with it once ' +
          'you are free. Never only promise to do it later.',
  )
  return lines.join('\n')
}

export function setAsideDoneNote(task: string, waitedOn: string[]): string {
  const what = waitedOn.length ? ` (${waitedOn.join('; ')})` : ''
  return (
    `[Milibot] You are free now: what you were waiting for finished${what}. Now do what you set aside in this ` +
    `conversation:\n\n${task}`
  )
}

/** To the bot the idle watch reports to, in its conversation with the stopped bot. */
export function idleWatchNote(
  botName: string,
  minutes: number,
  setAside: string[],
  openSessions: string[],
): string {
  const lines = [
    `[Milibot] ${botName} has done nothing for ${minutes} min while it has requests set aside for later, ` +
      'so nothing will wake it up:',
    ...setAside.map((task) => `- ${task}`),
  ]
  if (openSessions.length)
    lines.push(
      `Its work sessions still open (no turn running): ${openSessions.join('; ')}. One may be stuck or never finished.`,
    )
  lines.push(
    `What you write here reaches ${botName}: ask it to resume, finish its open work or drop what no longer ` +
      'applies, and tell the user if it needs their decision. One short message.',
  )
  return lines.join('\n')
}

/** Before what the user wrote in the conversation while the turn was working, when the turn takes it in. */
export const USER_WROTE_MEANWHILE_NOTE =
  '[Milibot] The user wrote this while you were working on this conversation. It may change or add to what you ' +
  'are doing: adjust the work that is left, without redoing or repeating what is already done.'

/** A resumed CLI session whose memory changed; `memory` is '' when it is now empty. */
export function memoryChangedNote(memory: string): string {
  return memory
    ? `[Milibot] Your memory changed since this session started; this is the current version:\n\n${memory}`
    : '[Milibot] Your memory changed since this session started: your pinned notes and conversation summaries are now empty (earlier ones were removed).'
}

export function sessionStateNote(state: string): string {
  return state ? `[Milibot] Where the session stands:\n${state}` : ''
}

/** CLI engines: which project applies to this turn; its whole block when the session has not seen it yet. */
export function projectNote(project: { name: string; block: string } | null, withBlock: boolean): string {
  if (project && withBlock) return `[Milibot] ${project.block}`
  if (project) return `[Milibot] Current project of this conversation: ${project.name}.`
  return '[Milibot] This conversation has no current project: only general knowledge and notes apply.'
}

export const SESSION_INTERRUPTED_NOTE = '[Milibot] Not completed: the session was interrupted.'

/** Sent once per turn when a session lane's model answers with neither text nor a tool call. */
export const EMPTY_SESSION_REPLY_NOTE =
  '[Milibot] Your last reply was empty. Continue with the next step of the session, or call session_finish if its goal is reached (or cannot be).'

export const STEP_LIMIT_NOTE =
  "[Milibot] You reached this turn's step limit: no more tools now. Write your final message: what is done, what is left and where the results are, in a few lines."

/** Context line added to a bot's input in group and internal conversations. */
export function conversationNote(
  conversation: ConversationSummary,
  bot: Bot,
  bots: Map<string, Bot>,
): string | null {
  const others = conversation.memberBotIds.filter((id) => id !== bot.id).map((id) => bots.get(id))
  if (conversation.type === 'group') {
    const names = others.map((b) => (b ? `${b.name}${b.label ? ` (${b.label})` : ''}` : null)).filter(Boolean)
    return (
      `[Milibot] Group chat "${conversation.title ?? 'group'}" with the user${names.length ? ` and ${names.join(', ')}` : ''}. ` +
      'The other bots\' messages appear as "[Name]: …". You were woken because someone @mentioned you or the ' +
      'message concerns your role: answer only your part, briefly, without repeating what others said, and ' +
      'address a bot with @Name when you need it. If you have nothing to add, say so in one short line. Your ' +
      'reply goes to the whole group.'
    )
  }
  if (conversation.type === 'internal') {
    const other = others[0]?.name ?? 'another bot'
    return (
      `[Milibot] Private conversation with ${other}, another bot of the team (the user can read it but does not ` +
      `take part). Answer ${other} here, briefly: the answer and where things are, pointing to files, docs or ` +
      `cards instead of pasting them. Your reply is delivered to ${other}; do not use ask_bot or message_bot to ` +
      `reply to ${other}.`
    )
  }
  return null
}
