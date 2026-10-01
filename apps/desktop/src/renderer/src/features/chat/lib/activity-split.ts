import type { ActivityPayload, ActivityStep } from '@milibot/shared'

export type ActivitySegment =
  | { type: 'note'; key: string; text: string }
  | { type: 'steps'; key: string; steps: ActivityStep[]; status: ActivityPayload['status'] }

/**
 * A turn's activity cut at the bot's notes: each note reads as a message of its own and the steps between
 * notes as separate cards. Only the last run of steps carries the turn's status; earlier runs are over.
 */
export function splitActivity(payload: ActivityPayload): ActivitySegment[] {
  const segments: ActivitySegment[] = []
  let run: ActivityStep[] = []
  const flush = () => {
    if (run.length === 0) return
    segments.push({ type: 'steps', key: run[0]?.toolCallId ?? '', steps: run, status: 'done' })
    run = []
  }
  for (const step of payload.steps) {
    if (step.kind !== 'note') {
      run.push(step)
      continue
    }
    flush()
    if (step.detail.trim()) segments.push({ type: 'note', key: step.toolCallId, text: step.detail })
  }
  flush()
  const last = segments.findLast((s) => s.type === 'steps')
  if (last?.type === 'steps') last.status = payload.status
  return segments
}
