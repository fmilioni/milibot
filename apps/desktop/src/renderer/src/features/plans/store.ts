import type { ModelChoice, Plan, PlanDetail, PlanExecution, WorkspaceEvent } from '@milibot/shared'
import { create } from 'zustand'

import { api } from '@/api/daemon'
import { createWorkspaceScope } from '@/api/workspace-scope'
import { type PlanFilters, planMatchesFilters } from '@/features/plans/lib/plans'
import { isPlanRunningInChat } from '@/features/sessions/lib/session-view'
import { removeById } from '@/lib/collections'

interface PlanState {
  /** Workspace the list belongs to (null: not loaded yet). */
  workspaceId: string | null
  plans: Plan[]
  filters: PlanFilters
  loading: boolean
  /** Bumped on every `plan.updated`/`plan.deleted`, so open plan views refetch. */
  revision: Record<string, number>
  /** Plans running in their chat (the sidebar's "in progress"), of `runningWorkspaceId`. */
  running: Plan[]
  runningWorkspaceId: string | null

  load(workspaceId: string, filters?: PlanFilters): Promise<void>
  loadRunning(workspaceId: string): Promise<void>
  detail(workspaceId: string, planId: string): Promise<PlanDetail>
  /** `mergePr` undefined: the plan follows the workspace's "merge PRs" preference. */
  approve(
    workspaceId: string,
    planId: string,
    execution?: PlanExecution,
    mergePr?: boolean,
    model?: ModelChoice | null,
  ): Promise<void>
  requestChanges(workspaceId: string, planId: string, comment: string): Promise<void>
  reject(workspaceId: string, planId: string, comment?: string): Promise<void>
  setStatus(workspaceId: string, planId: string, status: 'done' | 'cancelled'): Promise<void>
  remove(workspaceId: string, planId: string): Promise<void>
  applyEvent(workspaceId: string, event: WorkspaceEvent): void
}

const byUpdate = (plans: Plan[]) => [...plans].sort((a, b) => b.updatedAt - a.updatedAt)

export const usePlanStore = create<PlanState>()((set, get) => {
  const { forWorkspace, isCurrent } = createWorkspaceScope(get, set, () => ({ plans: [] }))
  const bump = (planId: string) =>
    set({ revision: { ...get().revision, [planId]: (get().revision[planId] ?? 0) + 1 } })

  return {
    workspaceId: null,
    plans: [],
    filters: {},
    loading: false,
    revision: {},
    running: [],
    runningWorkspaceId: null,

    async load(workspaceId, filters = get().filters) {
      forWorkspace(workspaceId)
      set({ loading: true, filters })
      try {
        const query = Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) as PlanFilters
        const plans = await api().call('listPlans', { params: { workspaceId }, query })
        if (isCurrent(workspaceId) && get().filters === filters) set({ plans })
      } finally {
        set({ loading: false })
      }
    },

    async loadRunning(workspaceId) {
      const lists = await Promise.all(
        (['approved', 'executing'] as const).map((status) =>
          api().call('listPlans', { params: { workspaceId }, query: { status } }),
        ),
      )
      set({ running: byUpdate(lists.flat().filter(isPlanRunningInChat)), runningWorkspaceId: workspaceId })
    },

    detail: (workspaceId, planId) => api().call('getPlan', { params: { workspaceId, planId } }),

    async approve(workspaceId, planId, execution, mergePr, model) {
      await api().call('approvePlan', {
        params: { workspaceId, planId },
        body: {
          ...(execution ? { execution } : {}),
          ...(mergePr !== undefined ? { mergePr } : {}),
          ...(model !== undefined ? { model } : {}),
        },
      })
    },

    async requestChanges(workspaceId, planId, comment) {
      await api().call('requestPlanChanges', { params: { workspaceId, planId }, body: { comment } })
    },

    async reject(workspaceId, planId, comment) {
      await api().call('rejectPlan', {
        params: { workspaceId, planId },
        body: comment?.trim() ? { comment: comment.trim() } : {},
      })
    },

    async setStatus(workspaceId, planId, status) {
      await api().call('setPlanStatus', { params: { workspaceId, planId }, body: { status } })
    },

    async remove(workspaceId, planId) {
      await api().call('deletePlan', { params: { workspaceId, planId } })
    },

    applyEvent(workspaceId, event) {
      if (event.type === 'plan.updated') {
        bump(event.payload.plan.id)
        const plan = event.payload.plan
        if (get().runningWorkspaceId === workspaceId) {
          const rest = removeById(get().running, plan.id)
          set({ running: isPlanRunningInChat(plan) ? byUpdate([...rest, plan]) : rest })
        }
        if (!isCurrent(workspaceId)) return
        const others = removeById(get().plans, plan.id)
        set({ plans: planMatchesFilters(plan, get().filters) ? byUpdate([...others, plan]) : others })
      } else if (event.type === 'plan.deleted') {
        bump(event.payload.planId)
        if (get().runningWorkspaceId === workspaceId)
          set({ running: removeById(get().running, event.payload.planId) })
        if (!isCurrent(workspaceId)) return
        set({ plans: removeById(get().plans, event.payload.planId) })
      }
    },
  }
})
