import type { ToolDefinition } from '../../llm/provider'
import { MODEL_REQUEST_ARGS } from '../model-args'
import { defineTools, scalarText } from './kit'

const definitions = {
  session_start: {
    name: 'session_start',
    description:
      'Open a work session for large work (its own conversation and long context, in parallel with your ' +
      'chats); its result comes back here. See the plans-and-sessions skill.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        goal: {
          type: 'string',
          description:
            'The request, decisions, paths and how to know it is done. The session does not see this ' +
            "conversation but reads the files itself: point to them, don't read or paste them first.",
        },
        plan: { type: 'string' },
        project: { type: 'string' },
        repo: { type: 'string' },
        folder: { type: 'string' },
        card: { type: 'string' },
        ...MODEL_REQUEST_ARGS,
      },
      required: ['title', 'goal'],
    },
  },
  list_models: {
    name: 'list_models',
    description:
      'The models you can open work on (session_start / plan_write / subagent `model`), per provider.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Words the model id or name must have.' } },
    },
  },
  session_finish: {
    name: 'session_finish',
    description:
      'Close this work session: "done" when its goal is reached, "failed" when it cannot be. The summary ' +
      'says what was done, where it is (files, branch, PR), what was verified and what is left.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: "Short result, in the user's language." },
        status: { type: 'string', enum: ['done', 'failed'] },
      },
      required: ['summary', 'status'],
    },
  },
} satisfies Record<string, ToolDefinition>

export const sessionTools = defineTools({
  definitions,
  describe(name, a, view) {
    switch (name) {
      case 'session_start':
        return { kind: name, detail: view.clip(scalarText(a.title), 60) }
      case 'list_models':
        return { kind: name, detail: view.clip(scalarText(a.query), 60) }
      case 'session_finish':
        return { kind: name, detail: '' }
    }
  },
  labels: {
    session_start: 'started work session',
    session_finish: 'finished work session',
    list_models: 'listed models',
  },
})
