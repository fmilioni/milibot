import type { ToolDefinition } from '../../llm/provider'
import { defineTools, scalarText } from './kit'

const definitions = {
  create_group: {
    name: 'create_group',
    description: 'Create a group chat with the user and some bots (names or ids).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        members: { type: 'array', items: { type: 'string' } },
      },
      required: ['name', 'members'],
    },
  },
  add_member: {
    name: 'add_member',
    description:
      'Add a bot to a group chat (the group name or id; "current" for this group). Allowed when you manage the ' +
      'team, or when you are in the group and its settings let bots manage members.',
    inputSchema: {
      type: 'object',
      properties: { group: { type: 'string' }, bot: { type: 'string' } },
      required: ['group', 'bot'],
    },
  },
  remove_member: {
    name: 'remove_member',
    description:
      'Remove a bot from a group chat (group name or id; "current" for this group). Same permission as ' +
      'add_member. The user usually has to confirm it in the chat first; give a short reason.',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string' },
        bot: { type: 'string' },
        reason: { type: 'string', description: 'One sentence shown to the user.' },
      },
      required: ['group', 'bot'],
    },
  },
  delete_bot: {
    name: 'delete_bot',
    description: 'Delete a bot (never yourself nor the last one); the user confirms it in the chat first.',
    inputSchema: {
      type: 'object',
      properties: {
        bot: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['bot'],
    },
  },
} satisfies Record<string, ToolDefinition>

export const memberTools = defineTools({
  definitions,
  describe(name, a) {
    switch (name) {
      case 'create_group':
        return { kind: name, detail: scalarText(a.name) }
      case 'add_member':
      case 'remove_member': {
        const group = scalarText(a.group)
        return {
          kind: name,
          detail:
            group && !/^(current|this)$/i.test(group) ? `${scalarText(a.bot)} · ${group}` : scalarText(a.bot),
        }
      }
      case 'delete_bot':
        return { kind: name, detail: scalarText(a.bot) }
    }
  },
})
