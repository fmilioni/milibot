import type { ToolDefinition } from '../../llm/provider'
import { defineTools, scalarText } from './kit'

/** `{shape, color, eyes}`, values listed in the team-management skill; random when omitted. */
const avatarSchema = { type: 'object' }

const definitions = {
  list_bots: {
    name: 'list_bots',
    description: 'List the bots of this workspace (name, label, role summary, status, model).',
    inputSchema: { type: 'object', properties: {} },
  },
  create_bot: {
    name: 'create_bot',
    description:
      'Create a specialist bot with its own desktop; it introduces itself to the user in its own chat. ' +
      'Load the team-management skill first.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        label: { type: 'string' },
        system_prompt: { type: 'string' },
        model: { type: 'string' },
        avatar: avatarSchema,
      },
      required: ['name', 'label', 'system_prompt'],
    },
  },
  update_bot: {
    name: 'update_bot',
    description: 'Change a bot (by id or name): name, label, system prompt, model or avatar.',
    inputSchema: {
      type: 'object',
      properties: {
        bot: { type: 'string' },
        name: { type: 'string' },
        label: { type: 'string' },
        system_prompt: { type: 'string' },
        reason: { type: 'string' },
        model: { type: 'string' },
        avatar: avatarSchema,
      },
      required: ['bot'],
    },
  },
  update_own_prompt: {
    name: 'update_own_prompt',
    description:
      'Update your own role section (the "# Your role" part of your instructions: who you are, your scope ' +
      'and how you work; never the shared Milibot rules). Use it only when the user changes or expands your ' +
      'role or scope, or corrects how you work in a way that should last; facts and preferences go to ' +
      'memory_save instead, and one-off requests change nothing. Send either the whole new text ' +
      '("new_persona") or exact replacements ("patch"). Max ~1500 tokens: a longer text is refused, so ' +
      'consolidate and move details to memory. The user sees the change and can undo it (or has to approve ' +
      'it, depending on the workspace setting). It takes effect from your next turn.',
    inputSchema: {
      type: 'object',
      properties: {
        new_persona: {
          type: 'string',
          description: "The complete new role section (replaces the current one), in the user's language.",
        },
        patch: {
          type: 'array',
          description: 'Exact replacements in the current role section, applied in order.',
          items: {
            type: 'object',
            properties: {
              old_text: {
                type: 'string',
                description: 'Exact current text; empty appends new_text at the end.',
              },
              new_text: { type: 'string' },
            },
            required: ['new_text'],
          },
        },
        reason: {
          type: 'string',
          description: 'What the user asked that motivates the change, in one sentence.',
        },
        user_requested: {
          type: 'boolean',
          description:
            'True only if the user explicitly asked in this conversation to change your role or instructions.',
        },
      },
      required: ['reason'],
    },
  },
} satisfies Record<string, ToolDefinition>

export const teamTools = defineTools({
  definitions,
  describe(name, a, view) {
    switch (name) {
      case 'list_bots':
        return { kind: name, detail: '' }
      case 'create_bot':
      case 'update_bot':
        return { kind: name, detail: scalarText(a.name) || scalarText(a.bot) }
      case 'update_own_prompt':
        return { kind: name, detail: view.clip(scalarText(a.reason), 60) }
    }
  },
  labels: { update_own_prompt: 'updated own prompt' },
})
