/** A store whose data belongs to one workspace at a time (null: nothing loaded yet). */
export interface WorkspaceScoped {
  workspaceId: string | null
}

export interface WorkspaceScope<S extends WorkspaceScoped> {
  /** Points the store at `workspaceId`, dropping another workspace's data (`reset`). */
  forWorkspace(workspaceId: string): void
  /** The store still holds `workspaceId`'s data (a response for another one must be dropped). */
  isCurrent(workspaceId: string): boolean
  /** Applies `patch` only while the store holds `workspaceId`'s data; returns whether it applied. */
  commit(workspaceId: string, patch: Partial<S> | (() => Partial<S>)): boolean
}

/**
 * The one convention for workspace data in stores: every action takes the `workspaceId` it works on (the
 * caller's `useWorkspaceId()`), starts with `forWorkspace` when it loads, and writes what the daemon
 * answers through `commit`, so a window that switched workspaces meanwhile never mixes them.
 */
export function createWorkspaceScope<S extends WorkspaceScoped>(
  get: () => S,
  set: (patch: Partial<S>) => void,
  reset?: () => Omit<Partial<S>, 'workspaceId'>,
): WorkspaceScope<S> {
  const isCurrent = (workspaceId: string) => get().workspaceId === workspaceId
  return {
    forWorkspace(workspaceId) {
      if (!isCurrent(workspaceId)) set({ ...reset?.(), workspaceId } as Partial<S>)
    },
    isCurrent,
    commit(workspaceId, patch) {
      if (!isCurrent(workspaceId)) return false
      set(typeof patch === 'function' ? patch() : patch)
      return true
    },
  }
}
