import type { ToolDefinition } from '../../llm/provider'
import { defineTools, scalarText } from './kit'

const definitions = {
  message_bot: {
    name: 'message_bot',
    description:
      'Send a message to another bot of the team (by name) without waiting: use it to delegate work that ' +
      'takes a while, or to hand over an update. It is posted in your private conversation with that bot (the ' +
      'user can read it). With expects_reply (default), its reply arrives later as a new message to you in this ' +
      'conversation, so finish your turn instead of waiting.',
    inputSchema: {
      type: 'object',
      properties: {
        bot: { type: 'string', description: 'Bot name or id.' },
        message: {
          type: 'string',
          description:
            'Self-contained request, straight to the point, with no greeting or self-introduction (the bot sees who ' +
            'sent it): the bot does not see this conversation. Point to files, docs or cards instead of pasting them.',
        },
        expects_reply: {
          type: 'boolean',
          description:
            'false for updates, hand-offs and answers to a question you were asked: the bot acts on it and ' +
            'nothing comes back to you. Default true (a request or question).',
        },
      },
      required: ['bot', 'message'],
    },
  },
  ask_bot: {
    name: 'ask_bot',
    description:
      'Ask another bot of the team (by name) a question and wait for its answer, which this tool returns. ' +
      'Use it for quick information you need to continue; for long tasks use message_bot. The message is ' +
      'posted in your private conversation with that bot (the user can read it).',
    inputSchema: {
      type: 'object',
      properties: {
        bot: { type: 'string', description: 'Bot name or id.' },
        message: {
          type: 'string',
          description:
            'Self-contained question, straight to the point, with no greeting or self-introduction (the bot sees who ' +
            'sent it): the bot does not see this conversation.',
        },
      },
      required: ['bot', 'message'],
    },
  },
  after_current_work: {
    name: 'after_current_work',
    description:
      'Set a request from this conversation aside until your work in progress (a work session, a request from ' +
      'another bot, a chat) finishes: you are woken here with it once you are free. Use it for something that ' +
      'must wait for what you are doing now, instead of only promising it. Each call adds a request; cancel ' +
      "drops this conversation's.",
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description:
            'What to do then, self-contained, with every detail the user gave (links, names, choices).',
        },
        cancel: { type: 'boolean', description: 'true drops every request set aside in this conversation.' },
      },
    },
  },
} satisfies Record<string, ToolDefinition>

export const messagingTools = defineTools({
  definitions,
  describe(name, a, view) {
    if (name === 'after_current_work')
      return { kind: name, detail: a.cancel === true ? '' : view.clip(scalarText(a.task), 80) }
    return { kind: name, detail: `${scalarText(a.bot)}: ${view.clip(scalarText(a.message), 60)}` }
  },
  labels: { ask_bot: 'asked', message_bot: 'messaged', after_current_work: 'set aside for later' },
})

/** Tools whose `bot` argument names the bot the step shows as the target. */
export const MESSAGING_TOOLS: ReadonlySet<string> = new Set(['ask_bot', 'message_bot'])
