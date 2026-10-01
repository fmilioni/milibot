import type { ActivityPayload, ActivityStep } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { splitActivity } from './activity-split'

const step = (
  id: string,
  kind: string,
  detail = '',
  status: ActivityStep['status'] = 'ok',
): ActivityStep => ({
  toolCallId: id,
  tool: kind,
  kind,
  detail,
  status,
  startedAt: 1,
  finishedAt: 2,
  durationMs: 1,
  error: null,
  screenshotSha: null,
})

const payload = (steps: ActivityStep[], status: ActivityPayload['status']): ActivityPayload => ({
  type: 'activity',
  turnId: 'trn_1',
  status,
  steps,
})

describe('splitActivity', () => {
  it('cuts the steps at each note; only the last run carries the turn status', () => {
    const segments = splitActivity(
      payload(
        [
          step('a', 'bash'),
          step('b', 'file_read'),
          step('n1', 'note', 'Design read. Now the scaffold.'),
          step('c', 'file_write', '', 'error'),
          step('n2', 'note', 'Tests next.'),
          step('d', 'bash', '', 'running'),
        ],
        'running',
      ),
    )
    expect(segments.map((s) => (s.type === 'note' ? ['note', s.text] : [s.status, s.steps.length]))).toEqual([
      ['done', 2],
      ['note', 'Design read. Now the scaffold.'],
      ['done', 1],
      ['note', 'Tests next.'],
      ['running', 1],
    ])
    expect(segments.map((s) => s.key)).toEqual(['a', 'n1', 'c', 'n2', 'd'])
  })

  it('keeps the status on the last run when the turn ends with a note, and drops empty notes', () => {
    const segments = splitActivity(
      payload(
        [step('n0', 'note', '  '), step('a', 'bash'), step('n1', 'note', 'Stopped here.')],
        'cancelled',
      ),
    )
    expect(segments).toMatchObject([
      { type: 'steps', status: 'cancelled' },
      { type: 'note', text: 'Stopped here.' },
    ])
  })
})
