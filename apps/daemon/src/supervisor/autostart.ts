import type { CloseBehavior, SetupStep } from '@milibot/shared'

export interface AutoStartCandidate {
  id: string
  setup: SetupStep
  closeBehavior: CloseBehavior
  /** Its runtime was running in the previous daemon session. */
  lastRunning: boolean
  enabledRoutines: number
}

/**
 * Runtimes a fresh daemon starts on its own, so routines fire and "keep running" VMs come back
 * without the user opening each window: workspaces that are set up, were running before and have
 * something to do in the background.
 */
export function selectAutoStart(candidates: AutoStartCandidate[]): string[] {
  return candidates
    .filter(
      (c) =>
        c.setup === 'done' && c.lastRunning && (c.enabledRoutines > 0 || c.closeBehavior === 'keep_running'),
    )
    .map((c) => c.id)
}
