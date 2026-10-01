import { PlanExecution, PlanStatus, TodoStatus } from '@milibot/shared'

import type { ToolDefinition } from '../../llm/provider'
import { MODEL_REQUEST_ARGS } from '../model-args'
import { defineTools, scalarText } from './kit'
import { PROJECT_SCOPE_ARG } from './projects'

const STEP_STATUS = [...TodoStatus.options]

const STR = { type: 'string' } as const

// Kept terse: the plans-and-sessions skill explains the parameters. todo_write and plan_step are used
// without the skill (sessions keep todo_write; other bots mark their steps), so they explain themselves.
const definitions = {
  plan_write: {
    name: 'plan_write',
    description:
      'Write a plan draft, or rewrite one (`plan`). Load the plans-and-sessions skill first; ' +
      'plan_submit sends it for approval.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: STR,
        title: STR,
        summary: STR,
        body: STR,
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 40,
          items: { type: 'object', properties: { title: STR, detail: STR }, required: ['title'] },
        },
        execution: { type: 'string', enum: [...PlanExecution.options] },
        project: STR,
        folder: STR,
        card: STR,
        ...MODEL_REQUEST_ARGS,
      },
      required: ['title', 'summary', 'body', 'steps'],
    },
  },
  plan_submit: {
    name: 'plan_submit',
    description: "Send a plan for the user's approval (a card) and wait for the decision.",
    inputSchema: {
      type: 'object',
      properties: { plan: STR },
      required: ['plan'],
    },
  },
  todo_write: {
    name: 'todo_write',
    description:
      "Update your step list: the approved plan you are executing or, in a work session, the session's own " +
      'list (only there: elsewhere there is no list to update). Send the steps that changed (by id) with their status; steps you leave out stay as they are. ' +
      'Keep exactly one step in_progress while you work, mark it done as soon as it is finished, add steps ' +
      'you discover and skip the ones that became unnecessary (with a note). The user sees the list live.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: 'Plan id; default: the approved plan of this conversation.' },
        todos: {
          type: 'array',
          minItems: 1,
          maxItems: 60,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Id of an existing step (keeps it); omit for a new one.' },
              title: { type: 'string' },
              status: { type: 'string', enum: STEP_STATUS },
              note: { type: 'string', description: 'Result, or why it was skipped (optional).' },
            },
            required: ['title', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },
  plan_step: {
    name: 'plan_step',
    description:
      "Mark ONE step of an approved plan, also another bot's plan whose step you were asked to do: " +
      'in_progress when you start it, done (with a short note of the result) as soon as it is finished, so ' +
      'the user follows the progress live. The owner of the plan keeps the full list with todo_write.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: 'Plan id or title.' },
        step: { type: 'string', description: 'Step id or title.' },
        status: { type: 'string', enum: STEP_STATUS },
        note: { type: 'string', description: 'Result, or why it was skipped (optional).' },
      },
      required: ['plan', 'step', 'status'],
    },
  },
  plan_get: {
    name: 'plan_get',
    description: 'Read a plan (body, steps with their status, the user feedback) by id or title.',
    inputSchema: { type: 'object', properties: { plan: STR }, required: ['plan'] },
  },
  plan_search: {
    name: 'plan_search',
    description: "Find the team's plans, past and current; without `query`, the most recent.",
    inputSchema: {
      type: 'object',
      properties: {
        query: STR,
        project: PROJECT_SCOPE_ARG,
        status: { type: 'string', enum: [...PlanStatus.options] },
      },
    },
  },
} satisfies Record<string, ToolDefinition>

export const planTools = defineTools({
  definitions,
  describe(name, a, view) {
    switch (name) {
      case 'plan_write':
        return { kind: name, detail: view.clip(scalarText(a.title), 60) }
      case 'plan_search':
        return { kind: name, detail: view.clip(scalarText(a.query), 60) }
      case 'plan_submit':
      case 'plan_get':
      case 'todo_write':
      case 'plan_step':
        // The plan's title comes from the tool result; ids mean nothing to the user.
        return { kind: name, detail: '' }
    }
  },
  labels: {
    plan_write: 'wrote plan',
    plan_submit: 'sent plan for approval',
    plan_get: 'read plan',
    plan_search: 'searched plans',
    todo_write: 'updated steps',
    plan_step: 'marked a step',
  },
})
