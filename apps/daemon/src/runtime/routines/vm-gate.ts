import type { CloseBehavior } from '@milibot/shared'

import { SETUP_PENDING_KEY, SETUP_VM_PENDING_KEY } from '../../workspace-db/setup-keys'
import type { SettingsStore } from '../settings'
import type { VmController } from '../vm'

/** `run`: go ahead; `boot`: start the VM and run (the turn waits for it); `wait`: hold the run until the VM is up. */
export type VmGate = 'run' | 'boot' | 'wait'

/**
 * Whether a routine due now runs: not while the workspace is being set up; with a VM to manage, a VM kept
 * running on close is booted for it and a suspended one is waited for.
 */
export function routineVmGate(deps: {
  settings: Pick<SettingsStore, 'get'>
  vm: Pick<VmController, 'status'>
  /** Absent: no VM to manage. */
  closeBehavior: (() => CloseBehavior) | null
}): VmGate {
  const { settings, vm, closeBehavior } = deps
  if (settings.get(SETUP_PENDING_KEY, false) || settings.get(SETUP_VM_PENDING_KEY, false)) return 'wait'
  if (!closeBehavior) return 'run'
  const state = vm.status().state
  if (state === 'running' || state === 'starting') return 'run'
  return closeBehavior() === 'keep_running' ? 'boot' : 'wait'
}
