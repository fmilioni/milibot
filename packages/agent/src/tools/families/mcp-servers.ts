import type { ToolDefinition } from '../../llm/provider'
import { defineTools, scalarText, shortUrl } from './kit'

const STR = { type: 'string' } as const
const KEY_VALUES = {
  type: 'array',
  items: {
    type: 'object',
    properties: { name: STR, value: STR },
    required: ['name'],
  },
} as const
const BOTS = { type: 'array', items: STR, description: 'Bot names, or ["all"].' } as const

// Kept terse: the mcp-servers skill explains the parameters.
const definitions = {
  mcp_server_list: {
    name: 'mcp_server_list',
    description: 'List the workspace MCP servers: status, sign-in, tools and which bots may use them.',
    inputSchema: { type: 'object', properties: {} },
  },
  mcp_server_add: {
    name: 'mcp_server_add',
    description:
      'Add an MCP server after the user confirms it in the chat, then test it. Secret values only as ' +
      '{{secret:NAME}}. Load the mcp-servers skill first.',
    inputSchema: {
      type: 'object',
      properties: {
        name: STR,
        url: STR,
        command: STR,
        args: { type: 'array', items: STR },
        headers: KEY_VALUES,
        env: KEY_VALUES,
        bots: BOTS,
        reason: STR,
      },
      required: ['name'],
    },
  },
  mcp_server_update: {
    name: 'mcp_server_update',
    description: 'Change an MCP server (by name or id) after the user confirms it; send only what changes.',
    inputSchema: {
      type: 'object',
      properties: {
        server: STR,
        name: STR,
        url: STR,
        command: STR,
        args: { type: 'array', items: STR },
        headers: KEY_VALUES,
        env: KEY_VALUES,
        bots: BOTS,
        enabled: { type: 'boolean' },
        reason: STR,
      },
      required: ['server'],
    },
  },
  mcp_server_remove: {
    name: 'mcp_server_remove',
    description: 'Remove an MCP server (by name or id) after the user confirms it.',
    inputSchema: { type: 'object', properties: { server: STR, reason: STR }, required: ['server'] },
  },
  mcp_server_test: {
    name: 'mcp_server_test',
    description: 'Reconnect to an MCP server (by name or id) and list its tools.',
    inputSchema: { type: 'object', properties: { server: STR }, required: ['server'] },
  },
  mcp_server_connect: {
    name: 'mcp_server_connect',
    description:
      'Start the sign-in (OAuth) of an MCP server: the user signs in from a card in the chat; waits for the ' +
      'outcome.',
    inputSchema: { type: 'object', properties: { server: STR }, required: ['server'] },
  },
} satisfies Record<string, ToolDefinition>

export const mcpServerTools = defineTools({
  definitions,
  describe(name, a, view) {
    switch (name) {
      case 'mcp_server_list':
        return { kind: name, detail: '' }
      case 'mcp_server_add': {
        const target =
          typeof a.url === 'string' ? shortUrl(a.url, view) : view.clip(scalarText(a.command), 60)
        return { kind: name, detail: [view.clip(scalarText(a.name), 40), target].filter(Boolean).join(' · ') }
      }
      default:
        return { kind: name, detail: view.clip(scalarText(a.server), 60) }
    }
  },
  labels: {
    mcp_server_list: 'MCP servers',
    mcp_server_add: 'MCP server add',
    mcp_server_update: 'MCP server change',
    mcp_server_remove: 'MCP server removal',
    mcp_server_test: 'MCP server test',
    mcp_server_connect: 'MCP sign-in',
  },
})
