import type { ToolDefinition } from '../../llm/provider'
import { defineTools, scalarText } from './kit'

const definitions = {
  daemon_logs: {
    name: 'daemon_logs',
    description:
      "Read the end of the Milibot daemon's log for this workspace (newest last, secrets redacted): turns, " +
      'bot and lane status changes, tool and service errors. Use it to find out why something of yours ' +
      'misbehaved (a status stuck, a tool failing, a message that never arrived).',
    inputSchema: {
      type: 'object',
      properties: {
        since: {
          type: 'string',
          description: 'ISO time or a duration back, e.g. "30m", "2h", "1d". Default 1h.',
        },
        level: {
          type: 'string',
          enum: ['debug', 'info', 'warn', 'error'],
          description: 'Minimum level. Default info.',
        },
        bot: { type: 'string', description: 'Only this bot\'s lines: name, id or "me". Default: every bot.' },
        contains: { type: 'string', description: 'Only lines containing this text (case-insensitive).' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Default 200.' },
        include_supervisor: {
          type: 'boolean',
          description:
            "Also the supervisor's lines (no workspace: app startup, workspaces opening). Default false.",
        },
      },
    },
  },
} satisfies Record<string, ToolDefinition>

export const diagnosticTools = defineTools({
  definitions,
  describe(_name, a) {
    const bot = scalarText(a.bot)
    return { kind: 'daemon_logs', detail: bot === 'me' ? '' : bot || scalarText(a.contains) }
  },
})
