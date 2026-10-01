import type { ToolDefinition } from '../../llm/provider'
import { defineTools, namedRef, scalarText } from './kit'

// Kept terse: every bot with the design skill pays for these on each request. The design skill's
// tool reference explains the parameters.

const STR = { type: 'string' } as const
const INT = { type: 'integer' } as const
const STRINGS = { type: 'array', items: STR } as const
const DESIGN_ARG = STR
/** `{name, type?, value? | values?: {theme: value}, delete?}`, described in the skill. */
const TOKENS = { type: 'array', items: { type: 'object' } } as const

const definitions = {
  design_create: {
    name: 'design_create',
    description: 'Create a design (canvas of frames).',
    inputSchema: {
      type: 'object',
      properties: { name: STR, themes: STRINGS, tokens: TOKENS, fonts: STRINGS },
      required: ['name'],
    },
  },
  design_list: {
    name: 'design_list',
    description: 'List designs.',
    inputSchema: { type: 'object', properties: { archived: { type: 'boolean' } } },
  },
  design_read: {
    name: 'design_read',
    description: 'Read a design; with frame, its HTML/CSS and outline.',
    inputSchema: { type: 'object', properties: { design: DESIGN_ARG, frame: STR }, required: ['design'] },
  },
  design_set_tokens: {
    name: 'design_set_tokens',
    description: 'Change themes, tokens (merged by name) and fonts.',
    inputSchema: {
      type: 'object',
      properties: {
        design: DESIGN_ARG,
        themes: STRINGS,
        rename_themes: { type: 'object', description: '{old: new}' },
        tokens: TOKENS,
        fonts: STRINGS,
      },
      required: ['design'],
    },
  },
  design_write_frame: {
    name: 'design_write_frame',
    description:
      'Create or replace a frame (HTML + Tailwind). Write name, width and height before html, html last. Returns problems and outline.',
    streamInput: true,
    inputSchema: {
      type: 'object',
      properties: {
        design: DESIGN_ARG,
        frame: { type: 'string', description: 'Frame to replace.' },
        name: STR,
        width: INT,
        height: { type: 'integer', description: '0 = auto.' },
        theme: STR,
        x: INT,
        y: INT,
        css: STR,
        html: STR,
      },
      required: ['design', 'name', 'width', 'html'],
    },
  },
  design_edit_frame: {
    name: 'design_edit_frame',
    description: 'Exact-text edits of a frame (all or none).',
    inputSchema: {
      type: 'object',
      properties: {
        design: DESIGN_ARG,
        frame: STR,
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: { old_text: STR, new_text: STR },
            required: ['old_text', 'new_text'],
          },
        },
      },
      required: ['design', 'frame', 'edits'],
    },
  },
  design_draw: {
    name: 'design_draw',
    description:
      'Start drawing flat vector art (logo, mark, flat mascot, pictogram, pattern) into a new art frame, in the ' +
      'background. Never icons, and never photos, people, scenes, products or backgrounds: those are generate_image.',
    inputSchema: {
      type: 'object',
      properties: {
        design: DESIGN_ARG,
        name: STR,
        prompt: { type: 'string', description: 'Subject, composition, style, hex colors.' },
        width: INT,
        height: INT,
        x: INT,
        y: INT,
      },
      required: ['design', 'name', 'prompt', 'width', 'height'],
    },
  },
  design_frame: {
    name: 'design_frame',
    description: 'Move, resize, rename, duplicate, delete, set_theme or reorder a frame.',
    inputSchema: {
      type: 'object',
      properties: {
        design: DESIGN_ARG,
        frame: STR,
        action: {
          type: 'string',
          enum: ['move', 'resize', 'rename', 'duplicate', 'delete', 'set_theme', 'reorder'],
        },
        x: INT,
        y: INT,
        width: INT,
        height: INT,
        name: STR,
        theme: STR,
        position: INT,
      },
      required: ['design', 'frame', 'action'],
    },
  },
  design_screenshot: {
    name: 'design_screenshot',
    description: 'Frames as images (max 4) with problems.',
    inputSchema: {
      type: 'object',
      properties: { design: DESIGN_ARG, frames: STRINGS, theme: STR, scale: { type: 'number' } },
      required: ['design', 'frames'],
    },
  },
  design_export: {
    name: 'design_export',
    description: 'Export frames to /workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        design: DESIGN_ARG,
        frames: STRINGS,
        format: { type: 'string', enum: ['png', 'pdf', 'html'] },
        path: STR,
        scale: { type: 'number' },
      },
      required: ['design', 'format', 'path'],
    },
  },
  design_archive: {
    name: 'design_archive',
    description: 'Archive or unarchive a design.',
    inputSchema: {
      type: 'object',
      properties: { design: DESIGN_ARG, archived: { type: 'boolean' } },
      required: ['design'],
    },
  },
  design_delete: {
    name: 'design_delete',
    description: 'Delete a design with all its frames and versions.',
    inputSchema: { type: 'object', properties: { design: DESIGN_ARG }, required: ['design'] },
  },
} satisfies Record<string, ToolDefinition>

export type DesignToolName = keyof typeof definitions

const DESIGN_ID = /^(dsg|dfr)_/i

export const designTools = defineTools({
  definitions,
  describe(name, a, view) {
    switch (name) {
      case 'design_create':
      case 'design_write_frame':
      case 'design_draw':
        return { kind: name, detail: view.clip(scalarText(a.name), 60) }
      case 'design_edit_frame':
      case 'design_frame':
        return { kind: name, detail: namedRef(scalarText(a.frame), DESIGN_ID, view) }
      case 'design_read':
      case 'design_set_tokens':
      case 'design_screenshot':
      case 'design_export':
      case 'design_archive':
      case 'design_delete':
        return { kind: name, detail: namedRef(scalarText(a.design), DESIGN_ID, view) }
      case 'design_list':
        return { kind: name, detail: '' }
    }
  },
  labels: {
    design_create: 'created design',
    design_list: 'designs',
    design_read: 'read design',
    design_set_tokens: 'changed design tokens',
    design_write_frame: 'drew frame',
    design_edit_frame: 'edited frame',
    design_draw: 'started drawing',
    design_frame: 'changed frame',
    design_screenshot: 'looked at design',
    design_export: 'exported design',
    design_archive: 'archived design',
    design_delete: 'deleted design',
  },
})

/** Tools whose input is shown while the model writes it (`AgentEnvironment.toolInputDraft`). */
export const DRAFT_TOOLS: ReadonlySet<string> = new Set(
  Object.values(definitions as Record<string, ToolDefinition>)
    .filter((tool) => tool.streamInput)
    .map((tool) => tool.name),
)
