import type { ToolDefinition } from '../../llm/provider'
import { defineTools, scalarText } from './kit'
import { PROJECT_SCOPE_ARG } from './projects'

/** Most notes one `replaces` list or `memory_forget` call may name. */
export const MAX_NOTE_REFS = 10

const definitions = {
  memory_save: {
    name: 'memory_save',
    description:
      'Save a durable fact to long-term memory, which survives across conversations and sessions. Only facts ' +
      'that are stable, likely to matter in future tasks, not already in your memory and stated or confirmed ' +
      'by the user. One fact per note, self-contained (it is read without the conversation). scope ' +
      '"workspace" is shared with every bot: the user\'s profile (name, country/locale, language, currency, ' +
      'number and date formats, tools they use, preferences) and team-wide facts; scope "bot" (default) is ' +
      'for what only your role needs; scope "project" is shared by every bot, but only while working on the ' +
      "conversation's current project (that project's conventions, decisions, environments). To correct or " +
      'complete a note, pass "replaces" with it instead of adding a contradicting one; to merge repeated ' +
      'notes into this one, pass them all as a list (the first keeps its place and date, the rest are ' +
      'removed; nothing changes if one does not match). Pinned bot notes ' +
      '(default) are always in your context; unpinned ones are only found with memory_search. Workspace notes ' +
      "are always in every bot's context; project notes whenever that project is current.",
    inputSchema: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description:
            "The fact, in one or two sentences (max 600 characters), in the user's language (they can read and edit it).",
        },
        scope: {
          type: 'string',
          enum: ['bot', 'workspace', 'project'],
          description:
            '"workspace" for facts every bot should know, "project" for facts of the current project; default "bot".',
        },
        replaces: {
          anyOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_NOTE_REFS },
          ],
          description:
            'The existing note this one replaces (its id, text or a unique part of it), or a list of notes to merge into this one.',
        },
        pinned: { type: 'boolean', description: 'Bot notes: keep it always in context (default true).' },
      },
      required: ['note'],
    },
  },
  memory_search: {
    name: 'memory_search',
    description: 'Search your long-term memory notes (pinned and unpinned) by keywords.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords.' },
        project: PROJECT_SCOPE_ARG,
        limit: { type: 'integer', minimum: 1, maximum: 30, description: 'Default 10.' },
      },
      required: ['query'],
    },
  },
  history_search: {
    name: 'history_search',
    description:
      'Full-text search over the complete message history of your conversations (older messages are only ' +
      'summarized in your context) and your memory notes. Use it when you need the exact wording, numbers ' +
      'or details of something said before.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords (names, numbers, distinctive words).' },
        conversation: {
          type: 'string',
          description: '"current" for this conversation only, or "all" (default) for all your conversations.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 30, description: 'Default 10.' },
      },
      required: ['query'],
    },
  },
  memory_forget: {
    name: 'memory_forget',
    description:
      'Remove notes from memory that are outdated or wrong: your own notes, the workspace ones and those of ' +
      "the current project (never another bot's private notes). All or none: nothing is removed if one does " +
      'not match. The user sees what was removed and the reason. To merge repeated notes, use memory_save ' +
      'with "replaces" instead.',
    inputSchema: {
      type: 'object',
      properties: {
        notes: {
          anyOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_NOTE_REFS },
          ],
          description: 'The note (its id, text or a unique part of it), or a list of notes.',
        },
        reason: {
          type: 'string',
          description: "Why it no longer holds, in one short sentence in the user's language.",
        },
      },
      required: ['notes', 'reason'],
    },
  },
} satisfies Record<string, ToolDefinition>

export const memoryTools = defineTools({
  definitions,
  describe(name, a, view) {
    if (name === 'memory_forget') return { kind: name, detail: view.clip(scalarText(a.reason), 60) }
    return { kind: name, detail: view.clip(scalarText(name === 'memory_save' ? a.note : a.query), 60) }
  },
  labels: {
    memory_save: 'remember',
    memory_search: 'memory search',
    history_search: 'history search',
    memory_forget: 'forget',
  },
})
