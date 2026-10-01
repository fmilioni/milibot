import type { Plan } from '@milibot/shared'

import { planMergeAllowed } from '../settings'

/** A lane of a work session whose plan may merge its pull request (`MILIBOT_ALLOW_MERGE` in its commands). */
export function mergeAllowedForLane(
  deps: {
    sessionOfLane: (laneKey: string | undefined) => { planId: string | null } | null
    plan: (planId: string) => Pick<Plan, 'mergePr'>
    autoMergePrs: () => boolean
  },
  laneKey: string | undefined,
): boolean {
  const planId = deps.sessionOfLane(laneKey)?.planId
  if (!planId) return false
  try {
    return planMergeAllowed(deps.plan(planId), deps.autoMergePrs())
  } catch {
    return false
  }
}
