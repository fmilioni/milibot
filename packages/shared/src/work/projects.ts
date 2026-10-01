import { z } from 'zod'

import { ConversationSummary } from '../chat/conversations'
import { endpoint, Ok, queryBool } from '../http/endpoint'

/*
 * Projects group what belongs to one line of work inside a workspace: knowledge documents, workspace notes,
 * plans, work sessions and boards carry an optional project (none = general, shared by every project). A
 * conversation has a current project: its bots see the general material plus that project's, and look into
 * another project only when they ask for it.
 */
export const Project = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  /** Repository names (as in /workspace/repos/<name>) or URLs the project works on. */
  repos: z.array(z.string()),
  vmPath: z.string().nullable(),
  createdByBotId: z.string().nullable(),
  archivedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type Project = z.infer<typeof Project>

const ProjectName = z.string().trim().min(1).max(80)
const ProjectRepos = z.array(z.string().trim().min(1).max(300)).max(20)

/**
 * Which projects' material a bot looks at. `default`: the general material plus the current project's
 * (none: general only); `only`: one project's; `general`: material without a project; `any`: everything.
 */
export type ProjectView =
  | { mode: 'default'; current: string | null }
  | { mode: 'only'; projectId: string }
  | { mode: 'general' }
  | { mode: 'any' }

/** Material of `projectId` (null = general) is in the view. */
export function inProjectView(projectId: string | null, view: ProjectView | undefined): boolean {
  switch (view?.mode) {
    case undefined:
    case 'any':
      return true
    case 'general':
      return projectId === null
    case 'only':
      return projectId === view.projectId
    case 'default':
      return projectId === null || projectId === view.current
  }
}

export const CreateProjectBody = z.object({
  name: ProjectName,
  description: z.string().trim().max(2000).default(''),
  repos: ProjectRepos.default([]),
  vmPath: z.string().trim().max(500).nullable().optional(),
})

export const UpdateProjectBody = z.object({
  name: ProjectName.optional(),
  description: z.string().trim().max(2000).optional(),
  repos: ProjectRepos.optional(),
  vmPath: z.string().trim().max(500).nullable().optional(),
  archived: z.boolean().optional(),
})

const ListProjectsQuery = z.object({
  archived: queryBool(false),
})

const SetConversationProjectBody = z.object({ projectId: z.string().nullable() })

export const projectEndpoints = {
  listProjects: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/projects',
    query: ListProjectsQuery,
    response: z.array(Project),
  }),
  createProject: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/projects',
    body: CreateProjectBody,
    response: Project,
  }),
  updateProject: endpoint({
    method: 'PATCH',
    path: '/w/:workspaceId/projects/:projectId',
    body: UpdateProjectBody,
    response: Project,
  }),
  /** Documents, notes and conversations of the project become general (nothing else is deleted). */
  deleteProject: endpoint({ method: 'DELETE', path: '/w/:workspaceId/projects/:projectId', response: Ok }),
  setConversationProject: endpoint({
    method: 'PATCH',
    path: '/w/:workspaceId/conversations/:conversationId/project',
    body: SetConversationProjectBody,
    response: ConversationSummary,
  }),
}
