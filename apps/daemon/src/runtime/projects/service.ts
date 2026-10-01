import type { NewAgentMessage } from '@milibot/agent'
import {
  type Bot,
  type ConversationSummary,
  type CreateProjectBody,
  estimateTokens,
  type Message,
  type Project,
  type projectEndpoints,
  slugify,
  type UpdateProjectBody,
  type WorkspaceEvent,
} from '@milibot/shared'
import type { z } from 'zod'

import type { Db } from '../../db/sqlite'
import { DaemonError, notFound } from '../../errors'
import type { EndpointHandlers } from '../../handlers'
import { foldKey, resolveByRef } from '../tools-core'
import type { WorkspaceStore } from '../workspace-store'
import { ProjectStore } from './store'

/** Lowercase ASCII slug of a project name ("New Store!" → "new-store"). */
export function projectSlug(name: string): string {
  return slugify(name, { maxLength: 40, fallback: 'project' })
}

/** Project notes in its block, oldest first; the rest are found with memory_search. */
const NOTES_BUDGET_TOKENS = 1200

/** Refs meaning "no project" in tool arguments. */
// Portuguese on purpose: bots often pass the user's own word for "general"/"none".
const GENERAL_REFS = new Set(['general', 'geral', 'none', 'nenhum', 'null', ''])

export interface ProjectServiceDeps {
  db: Db
  store: WorkspaceStore
  emit: (event: WorkspaceEvent) => void
  appendMessage: (message: NewAgentMessage) => Message
  now: () => number
  /** Knowledge documents of the project the bot can see, as catalog lines (pinned first). */
  knowledgeCatalog: (bot: Bot, projectId: string) => string
  /** The project's workspace notes, oldest first. */
  projectNotes: (projectId: string) => string[]
}

/** Result of resolving a project reference given by a bot. */
export type ProjectRef = { project: Project } | { general: true } | { problem: string }

/** Projects of the workspace: CRUD and the conversations' current project. */
export class ProjectService {
  private readonly rows: ProjectStore

  constructor(private readonly deps: ProjectServiceDeps) {
    this.rows = new ProjectStore(deps.db, deps.now)
  }

  list(includeArchived = false): Project[] {
    return this.rows.list(includeArchived)
  }

  find(id: string): Project | null {
    return this.rows.find(id)
  }

  get(id: string): Project {
    const project = this.find(id)
    if (!project) throw notFound('project', id)
    return project
  }

  /** A project by id, slug or name (case and accents ignored), archived ones included. */
  resolve(ref: string): ProjectRef {
    const value = ref.trim()
    if (GENERAL_REFS.has(foldKey(value))) return { general: true }
    const match = resolveByRef(this.list(true), value, {
      id: (p) => p.id,
      names: (p) => [p.name, p.slug],
      ambiguous: { exact: 'first', partial: 'report' },
    })
    if ('found' in match) return { project: match.found }
    if ('ambiguous' in match)
      return {
        problem: `"${value}" matches ${match.ambiguous.length} projects: ${match.ambiguous.map((p) => p.name).join(', ')}. Use the exact name.`,
      }
    return { problem: `There is no project "${value}" (project_list shows them).` }
  }

  /** Current project of a conversation (null: none, or an unknown conversation). */
  current(conversationId: string | null): Project | null {
    if (!conversationId) return null
    let projectId: string | null
    try {
      projectId = this.deps.store.conversations.get(conversationId).projectId
    } catch {
      return null
    }
    return projectId ? this.find(projectId) : null
  }

  private uniqueSlug(name: string, exceptId: string | null = null): string {
    const base = projectSlug(name)
    if (!this.rows.slugTaken(base, exceptId)) return base
    for (let n = 2; ; n++) {
      const candidate = `${base}-${n}`
      if (!this.rows.slugTaken(candidate, exceptId)) return candidate
    }
  }

  private checkName(name: string, exceptId: string | null = null): void {
    const clash = this.list(true).find((p) => p.id !== exceptId && foldKey(p.name) === foldKey(name))
    if (clash) throw new DaemonError('conflict', `A project named "${clash.name}" already exists`)
  }

  create(input: z.output<typeof CreateProjectBody>, createdByBotId: string | null = null): Project {
    this.checkName(input.name)
    const id = this.rows.insert({
      name: input.name,
      slug: this.uniqueSlug(input.name),
      description: input.description,
      repos: input.repos,
      vmPath: input.vmPath ?? null,
      createdByBotId,
    })
    const project = this.get(id)
    this.deps.emit({ type: 'project.updated', payload: { project } })
    return project
  }

  update(id: string, patch: z.output<typeof UpdateProjectBody>): Project {
    const current = this.get(id)
    if (patch.name !== undefined && foldKey(patch.name) !== foldKey(current.name))
      this.checkName(patch.name, id)
    const archivedAt =
      patch.archived === undefined
        ? current.archivedAt
        : patch.archived
          ? (current.archivedAt ?? this.deps.now())
          : null
    this.rows.update(id, {
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      repos: patch.repos ?? current.repos,
      vmPath: patch.vmPath === undefined ? current.vmPath : patch.vmPath,
      archivedAt,
    })
    const project = this.get(id)
    this.deps.emit({ type: 'project.updated', payload: { project } })
    return project
  }

  /** Its documents, notes and conversations become general. */
  delete(id: string): void {
    this.get(id)
    const conversations = this.deps.store.conversations
      .list()
      .filter((c) => c.projectId === id)
      .map((c) => c.id)
    this.rows.delete(id)
    this.deps.emit({ type: 'project.deleted', payload: { projectId: id } })
    for (const conversationId of conversations) this.emitConversation(conversationId)
  }

  private emitConversation(conversationId: string): void {
    try {
      const conversation = this.deps.store.conversations.get(conversationId)
      this.deps.emit({ type: 'conversation.updated', payload: { conversation } })
    } catch {
      // Deleted conversation: nothing to announce.
    }
  }

  /** Changes the conversation's current project and posts the "project changed" line. */
  setCurrent(
    conversationId: string,
    projectId: string | null,
    actor: { type: 'user' } | { type: 'bot'; bot: Bot; turnId: string | null },
  ): ConversationSummary {
    const before = this.deps.store.conversations.get(conversationId)
    const project = projectId ? this.get(projectId) : null
    if (before.projectId === projectId) return before
    const conversation = this.deps.store.conversations.setProject(conversationId, projectId)
    this.deps.emit({ type: 'conversation.updated', payload: { conversation } })
    const actorName = actor.type === 'bot' ? actor.bot.name : null
    this.deps.appendMessage({
      conversationId,
      authorType: 'system',
      kind: 'system_event',
      content: project
        ? `${actorName ?? 'You'} set the project to ${project.name}`
        : `${actorName ?? 'You'} cleared the project`,
      payload: {
        type: 'system',
        event: 'project_changed',
        botId: actor.type === 'bot' ? actor.bot.id : null,
        params: { projectName: project?.name ?? null, actor: actor.type, actorName },
      },
      turnId: actor.type === 'bot' ? actor.turnId : null,
    })
    return conversation
  }

  /**
   * The current project as the bots read it: name, description, repositories, its knowledge documents
   * (unless `knowledge` is false) and its workspace notes. '' when the project is gone.
   */
  block(bot: Bot, projectId: string, options: { knowledge?: boolean } = {}): string {
    const project = this.find(projectId)
    if (!project) return ''
    const lines = [`# Current project: ${project.name}`]
    if (project.description) lines.push(project.description)
    if (project.repos.length) lines.push(`Repositories: ${project.repos.join(', ')}`)
    if (project.vmPath) lines.push(`Folder in the VM: ${project.vmPath}`)
    lines.push(
      'Knowledge and notes below are specific to this project; general ones apply too. Other projects are ' +
        'out of scope unless you pass `project` to a search.',
    )
    const notes = this.deps.projectNotes(projectId)
    if (notes.length) {
      let used = 0
      const kept: string[] = []
      for (const note of notes) {
        const line = `- ${note}`
        used += estimateTokens(line)
        if (used > NOTES_BUDGET_TOKENS) break
        kept.push(line)
      }
      const omitted = notes.length - kept.length
      lines.push('', '## Project notes', ...kept)
      if (omitted > 0) lines.push(`(${omitted} more: memory_search)`)
    }
    const catalog = options.knowledge === false ? '' : this.deps.knowledgeCatalog(bot, projectId)
    if (catalog) lines.push('', catalog)
    return lines.join('\n')
  }

  handlers(): EndpointHandlers<keyof typeof projectEndpoints> {
    return {
      listProjects: ({ query }) => this.list(query.archived),
      createProject: ({ body }) => this.create(body),
      updateProject: ({ params, body }) => this.update(params.projectId, body),
      deleteProject: ({ params }) => {
        this.delete(params.projectId)
        return { ok: true as const }
      },
      setConversationProject: ({ params, body }) => {
        if (body.projectId) {
          const project = this.get(body.projectId)
          if (project.archivedAt) throw new DaemonError('conflict', 'The project is archived')
        }
        return this.setCurrent(params.conversationId, body.projectId, { type: 'user' })
      },
    }
  }
}
