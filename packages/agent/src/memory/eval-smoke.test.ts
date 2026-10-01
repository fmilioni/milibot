import { describe, expect, it } from 'vitest'

import { runLongMemoryEval } from '../../eval/long-memory/eval'

describe('long-memory eval (fake provider)', () => {
  it('recalls every planted fact through summaries, retrieval and hierarchical compaction', async () => {
    const report = await runLongMemoryEval({ provider: 'fake', filler: 120, tailBudget: 3000, seed: 7 })
    expect(report.accuracy).toBe(1)
    expect(report.llmCalls.summary).toBeGreaterThan(3)
    expect(report.summaries.maxLevel).toBeGreaterThan(0)
    expect(report.lastTurnsComposition.summaries).toBeGreaterThan(0)
    expect(report.lastTurnsComposition.recentTail).toBeLessThanOrEqual(3500)
    expect(report.costUsd.perTurn).toBeGreaterThan(0)
  })

  it('without retrieval, recalls the facts from the (extractive fake) summary chain', async () => {
    const report = await runLongMemoryEval({
      provider: 'fake',
      filler: 120,
      tailBudget: 3000,
      seed: 7,
      retrievedBudget: 0,
    })
    expect(report.retrievedInQuestions).toBe(0)
    expect(report.lastTurnsComposition.retrieved).toBe(0)
    expect(report.accuracy).toBe(1)
  })
})
