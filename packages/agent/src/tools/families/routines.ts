import type { ToolDefinition } from '../../llm/provider'
import { defineTools, scalarText } from './kit'

const STR = { type: 'string' } as const
/** Parsed by `parseSchedule` (plain words or cron); the routines skill documents it. */
const SCHEDULE = { type: 'string', description: 'Plain words or 5-field cron, local time.' }

// Kept terse: the routines skill explains the parameters.
const definitions = {
  routine_create: {
    name: 'routine_create',
    description: 'Schedule a recurring task for yourself (a routine). Load the routines skill first.',
    inputSchema: {
      type: 'object',
      properties: { name: STR, schedule: SCHEDULE, prompt: STR },
      required: ['name', 'schedule', 'prompt'],
    },
  },
  routine_list: {
    name: 'routine_list',
    description: 'List your routines: name, id, schedule, next run, last run and whether it is on.',
    inputSchema: { type: 'object', properties: {} },
  },
  routine_update: {
    name: 'routine_update',
    description: 'Change a routine (by name or id); send only what changes. enabled false pauses it.',
    inputSchema: {
      type: 'object',
      properties: { routine: STR, name: STR, schedule: SCHEDULE, prompt: STR, enabled: { type: 'boolean' } },
      required: ['routine'],
    },
  },
  routine_delete: {
    name: 'routine_delete',
    description: 'Delete a routine (by name or id) for good.',
    inputSchema: { type: 'object', properties: { routine: STR }, required: ['routine'] },
  },
} satisfies Record<string, ToolDefinition>

export const routineTools = defineTools({
  definitions,
  describe(name, a, view) {
    if (name === 'routine_list') return { kind: name, detail: '' }
    return { kind: name, detail: view.clip(scalarText(a.name) || scalarText(a.routine), 60) }
  },
  labels: {
    routine_create: 'routine created',
    routine_list: 'routines',
    routine_update: 'routine changed',
    routine_delete: 'routine deleted',
  },
})
