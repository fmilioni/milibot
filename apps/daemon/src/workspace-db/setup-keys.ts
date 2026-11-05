import type { Db } from '../db/sqlite'
import { SettingsStore } from '../runtime/settings/store'

/** Set while the workspace goes through the setup screens: the first bot waits to introduce itself. */
export const SETUP_PENDING_KEY = 'setup.pending'
/**
 * Set until the computer is configured (setup, or a switch to the VM): the runtime does not create/boot
 * the VM on its own.
 */
export const SETUP_VM_PENDING_KEY = 'setup.vm_pending'
/** The setup waits for the golden image build (missing or outdated) before creating the VM. */
export const SETUP_VM_WAIT_GOLDEN_KEY = 'setup.vm_wait_golden'

/** The workspace goes through the setup screens (providers, VM, login) before its chat. */
export function markSetupPending(db: Db): void {
  new SettingsStore(db).set(SETUP_PENDING_KEY, true)
  holdVmStart(db)
}

/** The next runtime leaves the VM off until `configureComputer` gives it its size and whether to boot. */
export function holdVmStart(db: Db): void {
  new SettingsStore(db).set(SETUP_VM_PENDING_KEY, true)
}
