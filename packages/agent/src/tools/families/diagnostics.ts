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
            "Also the lines of no workspace: the supervisor's (app startup, workspaces opening) and raw text (crash output). Default false.",
        },
      },
    },
  },
  vm_status: {
    name: 'vm_status',
    description:
      "Read the workspace VM's status, the same as the app's VM screen: state, CPUs, memory and disks, " +
      'restore points, the operation or system update in progress, and live usage (CPU, memory, disks inside ' +
      'the VM, what each bot uses). Read-only: it changes nothing.',
    inputSchema: { type: 'object', properties: {} },
  },
} satisfies Record<string, ToolDefinition>

export const diagnosticTools = defineTools({
  definitions,
  describe(name, a) {
    if (name === 'vm_status') return { kind: 'vm_status', detail: '' }
    const bot = scalarText(a.bot)
    return { kind: 'daemon_logs', detail: bot === 'me' ? '' : bot || scalarText(a.contains) }
  },
})
