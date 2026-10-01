import type { ToolDefinition } from '../../llm/provider'
import { EFFORT_ARG_HINT } from '../model-args'
import { defineTools, scalarText } from './kit'

const definitions = {
  subagent: {
    name: 'subagent',
    description:
      'Hand one self-contained task to a helper with its own short context that returns only a concise ' +
      'report: reading and mapping a lot of code, independent investigations (e.g. before writing a plan), ' +
      'or in a work session parts of the work that do not depend on each other (several subagent calls in ' +
      'one response run in parallel). The helper cannot ask the user anything and does not see this ' +
      'conversation: give it everything it needs in `task`/`context`. Helpers started from the chat are ' +
      'read-only; in a session use tools: "read_only" when it must not change files.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What to do and what to report back.' },
        context: { type: 'string', description: 'Facts, paths and decisions the helper needs.' },
        tools: { type: 'string', enum: ['read_only', 'all'], description: 'Default "all" (in a session).' },
        model: { type: 'string', description: 'Only when the user asked for one (see list_models).' },
        effort: { type: 'string', description: EFFORT_ARG_HINT },
      },
      required: ['task'],
    },
  },
} satisfies Record<string, ToolDefinition>

export const subagentTools = defineTools({
  definitions,
  describe(_name, a, view) {
    return { kind: 'subtask', detail: view.clip(scalarText(a.task), 80) }
  },
  labels: { subtask: 'helper' },
})
