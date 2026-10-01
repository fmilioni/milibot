import type { ToolExecContext, ToolResult } from '@milibot/agent'
import {
  flagArg,
  rawTextArg,
  stringListArg,
  textArg,
  type ToolArgs,
  toolError,
  toolText,
} from '@milibot/agent/tools'
import { CreateProjectBody, UpdateProjectBody } from '@milibot/shared'

import { oneLine, type ToolHandlers, ToolSwitch } from '../tools-core'
import type { ProjectService } from './service'

/** `repos` as a list; undefined when the call leaves them unchanged. */
function repoArgs(a: ToolArgs): string[] | undefined {
  return Array.isArray(a.repos) ? stringListArg(a, 'repos') : undefined
}

const given = (a: ToolArgs, key: string) => a[key] !== undefined && a[key] !== null

export interface ProjectToolsDeps {
  projects: ProjectService
}

export class ProjectTools extends ToolSwitch {
  readonly name = 'projects'
  protected readonly handlers: ToolHandlers = {
    project_list: (ctx, a) => this.list(ctx, a),
    project_create: (ctx, a) => {
      const name = textArg(a, 'name')
      if (!name) return toolError('"name" is required.')
      const vmPath = textArg(a, 'vm_path')
      const project = this.projects.create(
        CreateProjectBody.parse({
          name,
          description: textArg(a, 'description'),
          repos: repoArgs(a) ?? [],
          ...(vmPath ? { vmPath } : {}),
        }),
        ctx.bot.id,
      )
      return toolText(
        `Created the project ${project.name} (${project.slug}). Use project_set_current to make it the current project of this conversation.`,
        false,
        { detail: project.name },
      )
    },
    project_update: (_ctx, a) => {
      const found = this.projects.resolve(textArg(a, 'project'))
      if ('problem' in found) return toolError(found.problem)
      if ('general' in found) return toolError('"project" is required (its name).')
      const name = textArg(a, 'name')
      const repos = repoArgs(a)
      const archived = flagArg(a, 'archived')
      const patch = UpdateProjectBody.parse({
        ...(name ? { name } : {}),
        ...(given(a, 'description') ? { description: rawTextArg(a, 'description') } : {}),
        ...(repos ? { repos } : {}),
        ...(given(a, 'vm_path') ? { vmPath: textArg(a, 'vm_path') || null } : {}),
        ...(archived !== undefined ? { archived } : {}),
      })
      const project = this.projects.update(found.project.id, patch)
      return toolText(`Updated the project ${project.name}.`, false, { detail: project.name })
    },
    project_set_current: (ctx, a) => this.setCurrent(ctx, a),
  }

  constructor(private readonly deps: ProjectToolsDeps) {
    super()
  }

  private get projects(): ProjectService {
    return this.deps.projects
  }

  private list(ctx: ToolExecContext, a: ToolArgs): ToolResult {
    const projects = this.projects.list(flagArg(a, 'archived') === true)
    const current = this.projects.current(ctx.conversationId)
    if (!projects.length)
      return toolText(
        'There are no projects yet. Create one with project_create when a line of work needs it.',
      )
    const lines = projects.map((p) => {
      const marks = [p.id === current?.id ? 'current' : null, p.archivedAt ? 'archived' : null]
        .filter(Boolean)
        .join(', ')
      const repoList = p.repos.length ? ` · repos: ${p.repos.join(', ')}` : ''
      const description = p.description ? ` — ${oneLine(p.description, 160)}` : ''
      return `- ${p.name}${marks ? ` [${marks}]` : ''} (${p.slug})${repoList}${description}`
    })
    return toolText(
      `${current ? `Current project of this conversation: ${current.name}.` : 'This conversation has no project.'}\n${lines.join('\n')}`,
    )
  }

  private setCurrent(ctx: ToolExecContext, a: ToolArgs): ToolResult {
    if (!ctx.conversationId) return toolError('There is no conversation to set the project of.')
    const found = this.projects.resolve(textArg(a, 'project'))
    if ('problem' in found) return toolError(found.problem)
    const project = 'project' in found ? found.project : null
    if (project?.archivedAt)
      return toolError(`${project.name} is archived; unarchive it with project_update first.`)
    this.projects.setCurrent(ctx.conversationId, project?.id ?? null, {
      type: 'bot',
      bot: ctx.bot,
      turnId: ctx.turnId,
    })
    return toolText(
      project
        ? `The current project of this conversation is now ${project.name}: searches and new documents default to it (plus general material).`
        : 'This conversation has no project now: only general material is in scope by default.',
      false,
      { detail: project?.name ?? '' },
    )
  }
}
