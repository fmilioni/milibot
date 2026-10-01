import type { GoldenStatus, VmDetails, VmInfo, VmSystemUpdate, VmTask } from '@milibot/shared'

/** Revision the VM can move to, or null when its system is current (or the VM does not exist). */
export function availableSystemRevision(vm: VmInfo | null | undefined): number | null {
  const system = vm?.system
  return system && system.revision < system.latestRevision ? system.latestRevision : null
}

/** Revisions newer than the VM's, oldest first (each has its own "what's new" text). */
export function newRevisions(vm: VmInfo | null | undefined): number[] {
  const system = vm?.system
  if (!system) return []
  const revisions: number[] = []
  for (let r = system.revision + 1; r <= system.latestRevision; r++) revisions.push(r)
  return revisions
}

export type SystemUpdatePhase = VmSystemUpdate['status'] | 'running'

/** Where a requested system update is: still waiting (other operations run meanwhile) or replacing the system. */
export function systemUpdatePhase(
  details: Pick<VmDetails, 'task' | 'systemUpdate'>,
): SystemUpdatePhase | null {
  if (details.systemUpdate) return details.systemUpdate.status
  const task = details.task
  return task?.kind === 'update_system' && task.status === 'running' ? 'running' : null
}

/** A VM operation holds the VM: starting another one is refused until it ends. */
export function vmTaskBusy(task: VmTask | null | undefined): boolean {
  return task?.status === 'running' || task?.status === 'waiting_idle'
}

export type GoldenWait =
  | { state: 'building'; percent: number; etaSeconds: number | null }
  | { state: 'failed'; error: string }
  | { state: 'pending' }

/** What a system update waiting for the new golden image shows. */
export function goldenWait(golden: GoldenStatus | null): GoldenWait {
  if (golden?.state === 'building')
    return { state: 'building', percent: golden.percent, etaSeconds: golden.etaSeconds }
  if (golden && golden.error && (golden.state === 'failed' || golden.outdated))
    return { state: 'failed', error: golden.error }
  return { state: 'pending' }
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>

const dismissKey = (workspaceId: string, revision: number) =>
  `milibot.systemUpdate.dismissed.${workspaceId}.${revision}`

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function isSystemUpdateDismissed(
  workspaceId: string,
  revision: number,
  store: Storage | null = storage(),
): boolean {
  try {
    return store?.getItem(dismissKey(workspaceId, revision)) === '1'
  } catch {
    return false
  }
}

export function dismissSystemUpdate(
  workspaceId: string,
  revision: number,
  store: Storage | null = storage(),
): void {
  try {
    store?.setItem(dismissKey(workspaceId, revision), '1')
  } catch {
    // Storage blocked: the card simply comes back next time.
  }
}
