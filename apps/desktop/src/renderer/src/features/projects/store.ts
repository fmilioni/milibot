import type { Project, WorkspaceEvent } from '@milibot/shared'
import { create } from 'zustand'

import { api } from '@/api/daemon'
import { createWorkspaceScope } from '@/api/workspace-scope'
import { removeById, upsertById } from '@/lib/collections'

type CreateProject = { name: string; description?: string; repos?: string[]; vmPath?: string | null }
type UpdateProject = Partial<CreateProject> & { archived?: boolean }

interface ProjectState {
  /** Workspace the list belongs to (null: not loaded yet). */
  workspaceId: string | null
  /** Every project, archived ones included (the UI filters them). */
  projects: Project[]
  loading: boolean

  load(workspaceId: string): Promise<void>
  create(workspaceId: string, body: CreateProject): Promise<Project>
  update(workspaceId: string, projectId: string, body: UpdateProject): Promise<Project>
  remove(workspaceId: string, projectId: string): Promise<void>
  setConversationProject(workspaceId: string, conversationId: string, projectId: string | null): Promise<void>
  applyEvent(workspaceId: string, event: WorkspaceEvent): void
}

const sorted = (projects: Project[]) =>
  [...projects].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

const upsert = (projects: Project[], project: Project) => sorted(upsertById(projects, project))

export const useProjectStore = create<ProjectState>()((set, get) => {
  const { forWorkspace, isCurrent, commit } = createWorkspaceScope(get, set, () => ({ projects: [] }))

  return {
    workspaceId: null,
    projects: [],
    loading: false,

    async load(workspaceId) {
      forWorkspace(workspaceId)
      set({ loading: true })
      try {
        const projects = await api().call('listProjects', {
          params: { workspaceId },
          query: { archived: 'true' },
        })
        commit(workspaceId, { projects: sorted(projects) })
      } finally {
        set({ loading: false })
      }
    },

    async create(workspaceId, body) {
      const project = await api().call('createProject', {
        params: { workspaceId },
        body: { description: '', repos: [], ...body },
      })
      commit(workspaceId, { projects: upsert(get().projects, project) })
      return project
    },

    async update(workspaceId, projectId, body) {
      const project = await api().call('updateProject', { params: { workspaceId, projectId }, body })
      commit(workspaceId, { projects: upsert(get().projects, project) })
      return project
    },

    async remove(workspaceId, projectId) {
      await api().call('deleteProject', { params: { workspaceId, projectId } })
      commit(workspaceId, { projects: removeById(get().projects, projectId) })
    },

    async setConversationProject(workspaceId, conversationId, projectId) {
      await api().call('setConversationProject', {
        params: { workspaceId, conversationId },
        body: { projectId },
      })
    },

    applyEvent(workspaceId, event) {
      if (!isCurrent(workspaceId)) return
      if (event.type === 'project.updated') set({ projects: upsert(get().projects, event.payload.project) })
      else if (event.type === 'project.deleted')
        set({ projects: removeById(get().projects, event.payload.projectId) })
    },
  }
})
