import type { ToolDefinition } from '../../llm/provider'
import { defineTools, scalarText } from './kit'

const definitions = {
  skill_load: {
    name: 'skill_load',
    description:
      'Load one skill of your catalog (the "# Skills" list) by name: its instructions, the files it has and ' +
      'where they are in the VM. Load it before doing that kind of task and follow it.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Skill name as listed in your catalog.' } },
      required: ['name'],
    },
  },
  skill_read: {
    name: 'skill_read',
    description:
      'Read one file of a skill (a reference, a template, an image) by its path inside the skill, as ' +
      'skill_load lists it. Scripts are run from their folder in the VM instead.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name.' },
        path: { type: 'string', description: 'File path inside the skill, e.g. "reference/api.md".' },
      },
      required: ['name', 'path'],
    },
  },
  skill_save: {
    name: 'skill_save',
    description:
      'Create or update one of your own skills: a SKILL.md plus optional files, or a folder you prepared in ' +
      '/workspace (from_path). Load the skill-creator skill first.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        body: { type: 'string' },
        files: {
          type: 'array',
          maxItems: 50,
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
          },
        },
        from_path: { type: 'string' },
        scope: { type: 'string', enum: ['me', 'all'] },
      },
      required: ['name'],
    },
  },
  skill_delete: {
    name: 'skill_delete',
    description: 'Delete one of the skills you created (by name).',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
} satisfies Record<string, ToolDefinition>

export const skillTools = defineTools({
  definitions,
  describe(name, a, view) {
    if (name !== 'skill_read') return { kind: name, detail: view.clip(scalarText(a.name), 60) }
    const skill = view.clip(scalarText(a.name), 40)
    const path = view.clip(scalarText(a.path), 60)
    return { kind: name, detail: skill && path ? `${skill} · ${path}` : skill || path }
  },
  labels: {
    skill_load: 'loaded skill',
    skill_read: 'read skill file',
    skill_save: 'saved skill',
    skill_delete: 'deleted skill',
  },
})
