import { z } from 'zod'

/**
 * What started a bot turn. `user_message`: the user wrote (DM or group); `group_message`: another
 * bot spoke in a group; `bot_message`: a bot wrote to this one in their internal conversation
 * (ask_bot/message_bot); `bot_reply`: the answer to this bot's message_bot; `user_answer`: the user
 * answered an `ask_user`/`request_secret` after the tool stopped waiting; `routine`: a routine ran
 * (its instructions are the `routine_run` card just posted in the conversation); `plan_decision`: the user
 * decided on a plan after `plan_submit` stopped waiting; `session_start`: a work session's first turn (its
 * brief is the `session_brief` card in the session's conversation); `session_finished`: a work session the bot
 * started ended, in the chat where it started (the result is the turn's note); `subagent`: a helper doing one
 * task for a work session (`subagent` tool), whose text goes back to the session instead of the chat;
 * `after_current_work`: the bot's other work it set a request aside for finished (the request is the turn's note).
 */
export const TurnTrigger = z.enum([
  'user_message',
  'intro',
  'group_message',
  'bot_message',
  'bot_reply',
  'user_answer',
  'routine',
  'plan_decision',
  'session_start',
  'session_finished',
  'subagent',
  'after_current_work',
])
export type TurnTrigger = z.infer<typeof TurnTrigger>
