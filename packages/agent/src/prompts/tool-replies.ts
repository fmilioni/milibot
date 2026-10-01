import { USER_TOOK_CONTROL_NOTE } from './rules'

// Results of the tools the host runs itself and of the calls it refuses, as the model reads them.

export const CANCELLED = 'Cancelled: the user stopped this task.'

export const gateReplies = {
  notHere: (tool: string) => `Not executed: ${tool} is not available here.`,
  skillOff: (tool: string) =>
    `Not executed: ${tool} belongs to a skill that is turned off for you. Do the task another way or tell the user.`,
  readOnly: (tool: string) =>
    `Not executed: ${tool} is not available in a read-only task; report instead of changing things.`,
  useAlias: (tool: string, alias: string) => `Not executed: there is no tool named ${tool}; use ${alias}.`,
  notInTurn: (tool: string) => `Not executed: ${tool} is not available in this turn.`,
  userTookControl: `Not executed. ${USER_TOOK_CONTROL_NOTE}`,
}

/** Where the lane holding the screen works, from the waiting lane's point of view. */
export type ScreenHolder = 'main' | 'internal' | 'session'

export function screenBusyReply(holder: ScreenHolder, seconds: number): string {
  const where =
    holder === 'main'
      ? 'your chat conversations'
      : holder === 'internal'
        ? 'a request from another bot'
        : 'one of your work sessions'
  return `Not executed: your screen (computer and browser) is in use by another task of yours (${where}) and did not free up within ${seconds} s. Continue without the screen, or try again later.`
}

export const messagingReplies = {
  missingArgs: 'Invalid input: "bot" and "message" are required.',
  noSuchBot: (ref: string) => `There is no bot named "${ref}" (use list_bots).`,
  self: 'You cannot message yourself.',
  targetWaiting: (name: string) =>
    `${name} is waiting for your answer (it asked you). Reply in this conversation instead of messaging it back.`,
  chainTooLong:
    'Too many bots are already waiting on each other for this request. Answer with what you have, or ask the user.',
  wouldDeadlock: (name: string) =>
    `${name} is waiting for your answer right now; asking it back would block you both.`,
  noConversation: 'No conversation to report the message in.',
  heldForUser: (name: string) =>
    "Not sent yet: the bots have gone back and forth for a while since the user's last message, so the user " +
    `decides on a card in the chat whether this goes on (it is sent to ${name} if they do). ` +
    'Finish your turn telling the user, in one or two sentences, where things stand and why it should go on.',
  sentNotice: (name: string) => `Sent to ${name} as an update: nothing comes back to you.`,
  sent: (name: string) =>
    `Sent to ${name}. Its reply will arrive later as a new message in this conversation; do not wait for it.`,
  askTimedOut: (name: string, seconds: number) =>
    `${name} did not answer within ${seconds} s. Its reply will arrive later as a new message in this conversation; continue without it for now.`,
  askFailed: (name: string) => `${name} could not answer (its turn failed or was stopped).`,
  answered: (name: string, reply: string) => `${name} replied:\n\n${reply}`,
}

export const setAsideReplies = {
  noConversation: 'Not executed: there is no conversation to come back to.',
  dropped: 'Dropped: nothing is set aside in this conversation anymore.',
  nothingToDrop: 'Nothing was set aside in this conversation.',
  missingTask: 'Invalid input: "task" is required (or cancel: true).',
  nothingRunning: 'Nothing else of yours is running now: do it in this turn instead of setting it aside.',
  setAside: (waitingOn: string[]) =>
    `Set aside until ${waitingOn.join(' and ')} finishes; you will be woken here with it then ` +
    '(this replaces anything set aside before in this conversation). Tell the user in one short line and end ' +
    'your turn; do not start it now.',
}

export const helperReplies = {
  wrongLane: 'subagent only works in your chat turns and work sessions.',
  missingTask: 'Invalid input: "task" is required.',
  sessionLimit: (max: number) =>
    `This session already started its ${max} helpers: do the rest of the work yourself.`,
  turnLimit: (max: number) => `This turn already started its ${max} helpers: do the rest yourself.`,
  stopped: (report: string) =>
    `The helper was stopped before finishing.${report ? ` What it had so far:\n\n${report}` : ''}`,
  failed: (failure: string | null, report: string) =>
    `The helper could not finish${failure ? `: ${failure}` : ' (it wrote no report)'}.` +
    (report ? `\n\nWhat it had so far:\n\n${report}` : ''),
  report: (report: string, modelNote: string) =>
    `Helper report:\n\n${report}${modelNote ? `\n\n(${modelNote})` : ''}`,
}
