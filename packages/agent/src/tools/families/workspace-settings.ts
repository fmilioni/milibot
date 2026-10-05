import type { ToolDefinition } from '../../llm/provider'
import { defineTools } from './kit'

// Kept terse: the workspace-settings skill explains the fields and their values.
const definitions = {
  workspace_settings_get: {
    name: 'workspace_settings_get',
    description:
      'Read the workspace preferences you may change: current values, limits and which need confirmation.',
    inputSchema: { type: 'object', properties: {} },
  },
  workspace_settings_update: {
    name: 'workspace_settings_update',
    description:
      'Change workspace preferences: {field: value}, only what changes. Some fields wait for the user to ' +
      'confirm them on a card in the chat. Load the workspace-settings skill first.',
    inputSchema: {
      type: 'object',
      properties: {
        settings: { type: 'object', additionalProperties: true },
        reason: { type: 'string' },
      },
      required: ['settings'],
    },
  },
} satisfies Record<string, ToolDefinition>

export const workspaceSettingsTools = defineTools({
  definitions,
  describe(name, a) {
    if (name === 'workspace_settings_get') return { kind: name, detail: '' }
    const fields =
      a.settings && typeof a.settings === 'object' && !Array.isArray(a.settings)
        ? Object.keys(a.settings)
        : []
    return { kind: name, detail: fields.join(', ') }
  },
  labels: {
    workspace_settings_get: 'workspace settings',
    workspace_settings_update: 'workspace settings change',
  },
})
