import type { ToolDefinition } from '../../llm/provider'
import { EFFORT_ARG_HINT } from '../model-args'
import { defineTools, scalarText } from './kit'

/** `{shape, color, eyes}`, values listed in the team-management skill; random when omitted. */
const avatarSchema = { type: 'object' }
const STR = { type: 'string' } as const
const NAMES = { type: 'array', items: STR } as const

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
  set_model: {
    name: 'set_model',
    description:
      "Change the model or reasoning effort a bot works on, yours by default (the same setting as the bot's " +
      'settings in the app): use it when the user asks you to switch model or effort ("use effort high", ' +
      '"switch to Opus"). Send only what changes. Another bot only when you manage the team. It takes effect ' +
      'from the next turn and lasts; open work sessions keep their own model.',
    inputSchema: {
      type: 'object',
      properties: {
        bot: { type: 'string', description: 'Name or id of another bot; omit for yourself.' },
        model: { type: 'string', description: 'Model name or id (list_models shows them).' },
        effort: { type: 'string', description: `${EFFORT_ARG_HINT} "default" = the model's own.` },
        context: {
          type: 'string',
          description: 'Context limit, e.g. 200000, 256k, 1m; "default" = the whole window.',
        },
        provider: { type: 'string', description: 'Only when the user said which provider.' },
      },
    },
  },
  skill_import: {
    name: 'skill_import',
    description:
      'Import skills from a GitHub repository or a .zip/.skill file under /workspace after the user confirms ' +
      'it in the chat. Load the team-management skill first.',
    inputSchema: {
      type: 'object',
      properties: { source: STR, skills: NAMES, bots: NAMES, reason: STR },
      required: ['source'],
    },
  },
  bot_skills_set: {
    name: 'bot_skills_set',
    description: 'Turn skills on or off for a bot (yours by default) after the user confirms it in the chat.',
    inputSchema: {
      type: 'object',
      properties: { bot: STR, enable: NAMES, disable: NAMES, reason: STR },
    },
  },
  bot_mcp_set: {
    name: 'bot_mcp_set',
    description:
      'Turn MCP servers on or off for a bot (yours by default) after the user confirms it in the chat.',
    inputSchema: {
      type: 'object',
      properties: { bot: STR, enable: NAMES, disable: NAMES, reason: STR },
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
      case 'set_model':
        return {
          kind: name,
          detail: [scalarText(a.bot), scalarText(a.model), scalarText(a.effort)].filter(Boolean).join(' · '),
        }
      case 'skill_import':
        return { kind: name, detail: view.clip(scalarText(a.source), 60) }
      case 'bot_skills_set':
      case 'bot_mcp_set':
        return { kind: name, detail: view.clip(scalarText(a.bot), 40) }
    }
  },
  labels: {
    update_own_prompt: 'updated own prompt',
    set_model: 'changed model',
    skill_import: 'skill import',
    bot_skills_set: 'bot skills change',
    bot_mcp_set: 'bot MCP servers change',
  },
})
