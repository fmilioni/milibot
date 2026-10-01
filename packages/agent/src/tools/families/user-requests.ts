import type { ToolDefinition } from '../../llm/provider'
import { defineTools, scalarText } from './kit'

const definitions = {
  ask_user: {
    name: 'ask_user',
    description:
      'Ask the user to decide something you need to continue, as a card with clickable options (the user can ' +
      'also write their own answer); waits for the answer and returns it. Use it when a decision is truly ' +
      "the user's and there are clear alternatives (which account, which approach, what to do about a " +
      'conflict), not for casual conversation or things you can reasonably decide yourself. Almost always ' +
      'mark the option you advise with recommended: true (one per single-choice question; the user can accept ' +
      'it with Enter); omit it only when the options are truly neutral. Write everything in the language of ' +
      'the user.',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              header: {
                type: 'string',
                description: 'Very short label of the question (max 12 characters).',
              },
              question: { type: 'string', description: 'The question, clear and complete.' },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 4,
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: 'Short option text (1–5 words).' },
                    description: { type: 'string', description: 'What choosing it means (optional).' },
                    recommended: { type: 'boolean', description: 'The option you advise.' },
                  },
                  required: ['label'],
                },
              },
              multi_select: { type: 'boolean', description: 'The user may pick several options.' },
            },
            required: ['header', 'question', 'options'],
          },
        },
      },
      required: ['questions'],
    },
  },
  request_secret: {
    name: 'request_secret',
    description:
      'Ask the user for a password, token, PIN or other secret through a secure field in the chat (check ' +
      'list_secrets first). The value never reaches you, the chat or the logs: waits for the user and returns ' +
      'how to use it by reference.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'UPPER_SNAKE_CASE identifier, e.g. BANK_PASSWORD or GITLAB_TOKEN.',
        },
        label: {
          type: 'string',
          description: 'What it is, in the user\'s language (e.g. "Bank password").',
        },
        reason: { type: 'string', description: "Why you need it, in the user's language (one sentence)." },
        as_env: {
          type: 'boolean',
          description:
            'Also make it an environment variable $NAME of your commands (for tools/SDKs that read one).',
        },
        replace: {
          type: 'boolean',
          description: 'Ask again for a secret you already have (e.g. the password was wrong).',
        },
      },
      required: ['name', 'label', 'reason'],
    },
  },
  list_secrets: {
    name: 'list_secrets',
    description:
      'List the secrets you can use by reference ({{secret:NAME}}, "$MILIBOT_SECRETS_DIR/NAME") and which of ' +
      'them are also environment variables. Values are never shown.',
    inputSchema: { type: 'object', properties: {} },
  },
} satisfies Record<string, ToolDefinition>

export type UserRequestToolName = keyof typeof definitions

export const userRequestTools = defineTools({
  definitions,
  describe(name, a, view) {
    switch (name) {
      case 'ask_user': {
        const first = Array.isArray(a.questions)
          ? (a.questions[0] as { question?: unknown } | undefined)
          : undefined
        return { kind: name, detail: view.clip(scalarText(first?.question), 80) }
      }
      case 'request_secret':
        return { kind: name, detail: view.clip(scalarText(a.label) || scalarText(a.name), 60) }
      case 'list_secrets':
        return { kind: name, detail: '' }
    }
  },
  labels: { ask_user: 'asked you', request_secret: 'asked for a secret', list_secrets: 'secrets' },
})
