import type { ProjectView } from '@milibot/shared'

import type { ToolDefinition } from '../../llm/provider'
import { defineTools, scalarText } from './kit'

const STR = { type: 'string' } as const
const STRINGS = { type: 'array', items: STR } as const

// Kept terse: the projects skill explains the parameters.
const definitions = {
  project_list: {
    name: 'project_list',
    description:
      'List the projects (lines of work: products, clients, trips…) with their repositories and which one ' +
      'is the current project of this conversation.',
    inputSchema: { type: 'object', properties: { archived: { type: 'boolean' } } },
  },
  project_create: {
    name: 'project_create',
    description: 'Create a project for a lasting line of work. Load the projects skill first.',
    inputSchema: {
      type: 'object',
      properties: { name: STR, description: STR, repos: STRINGS, vm_path: STR },
      required: ['name'],
    },
  },
  project_update: {
    name: 'project_update',
    description: 'Change a project (by name or id); send only what changes. archived true hides it.',
    inputSchema: {
      type: 'object',
      properties: {
        project: STR,
        name: STR,
        description: STR,
        repos: STRINGS,
        vm_path: STR,
        archived: { type: 'boolean' },
      },
      required: ['project'],
    },
  },
  project_set_current: {
    name: 'project_set_current',
    description:
      'Set the current project of this conversation (name or id; "general" clears it) when what the user ' +
      'is talking about clearly belongs to one.',
    inputSchema: { type: 'object', properties: { project: STR }, required: ['project'] },
  },
} satisfies Record<string, ToolDefinition>

export const projectTools = defineTools({
  definitions,
  describe(name, a, view) {
    switch (name) {
      case 'project_list':
        return { kind: name, detail: '' }
      case 'project_create':
      case 'project_set_current':
        return { kind: name, detail: view.clip(scalarText(a.name) || scalarText(a.project), 60) }
      case 'project_update':
        return { kind: name, detail: view.clip(scalarText(a.project), 60) }
    }
  },
  labels: {
    project_list: 'projects',
    project_create: 'project created',
    project_update: 'project changed',
    project_set_current: 'project',
  },
})

/** `project` argument of the search tools: which projects' material to look at. */
export const PROJECT_SCOPE_ARG = {
  type: 'string',
  description: 'Default: the current project plus general material; or a project name, "general", "all".',
}

export interface ProjectResolver {
  resolve(ref: string): { project: { id: string } } | { general: true } | { problem: string }
}

/** The view a `project` tool argument asks for; `problem` when it names no project. */
export function projectViewArg(
  value: unknown,
  current: string | null,
  resolver: ProjectResolver | null | undefined,
): ProjectView | { problem: string } {
  const ref = typeof value === 'string' ? value.trim() : ''
  // Portuguese on purpose: models writing for a Portuguese-speaking user pass "atual" and "todos".
  if (!ref || /^(current|atual)$/i.test(ref)) return { mode: 'default', current }
  if (/^(all|any|todos|todas|tudo)$/i.test(ref)) return { mode: 'any' }
  if (!resolver) return { mode: 'default', current }
  const found = resolver.resolve(ref)
  if ('problem' in found) return found
  if ('general' in found) return { mode: 'general' }
  return { mode: 'only', projectId: found.project.id }
}
