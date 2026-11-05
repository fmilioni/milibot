import { computerCapabilities, type ComputerCapability, type WorkspaceSummary } from '@milibot/shared'

/** Whether the workspace's computer offers `capability`: screens ask this, never the computer kind. */
export function workspaceHas(
  workspace: Pick<WorkspaceSummary, 'computer'>,
  capability: ComputerCapability,
): boolean {
  return computerCapabilities(workspace.computer).has(capability)
}

/** `workspaceHas` for a window's current workspace; true until it is known, so VM screens don't flash away. */
export function currentComputerHas(
  state: { workspaces: readonly Pick<WorkspaceSummary, 'id' | 'computer'>[]; workspaceId: string | null },
  capability: ComputerCapability,
): boolean {
  const workspace = state.workspaces.find((w) => w.id === state.workspaceId)
  if (!workspace) {
    return true
  }

  return workspaceHas(workspace, capability)
}
