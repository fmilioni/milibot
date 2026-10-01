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

/**
 * What else the bot is doing right now in its other lanes (`work`), and what this conversation set aside for
 * when that finishes. `canSetAside`: the lane offers `after_current_work`.
 */
export function otherWorkNote(work: string[], setAside: string | null, canSetAside: boolean): string {
  const lines = [
    '[Milibot] Your other work in progress right now, running on its own beside this conversation:',
    ...work.map((w) => `- ${w}`),
  ]
  if (setAside) lines.push(`Set aside in this conversation for when it finishes: ${setAside}`)
  lines.push(
    canSetAside
      ? 'When the user speaks of "the current one" or of what you are doing now, they may mean this work. For ' +
          'something they want only after it finishes, call after_current_work and end your turn instead of ' +
          'starting it now.'
      : 'When the user or another bot speaks of what you are doing now, they may mean this work.',
  )
  return lines.join('\n')
}

export function setAsideDoneNote(task: string, finished: string[]): string {
  return (
    `[Milibot] What you were waiting for finished (${finished.join('; ')}). Now do what you set aside in this ` +
    `conversation:\n\n${task}`
  )
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
