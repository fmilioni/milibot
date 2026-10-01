import { PREFERENCE_SETTING_KEYS } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { SpendGuard } from '../../../src/runtime/spend/guard'

function settingsBag(initial: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = { ...initial }
  return {
    values,
    getSetting: <T>(key: string, fallback: T): T => (key in values ? (values[key] as T) : fallback),
    setSetting: (key: string, value: unknown) => {
      values[key] = value
    },
  }
}

describe('spend limits', () => {
  function guard(limits: { warn?: number; pause?: number }) {
    let clock = new Date(2026, 8, 26, 10, 0).getTime()
    let cost = 0
    const bag = settingsBag({
      [PREFERENCE_SETTING_KEYS.spendWarnUsd]: limits.warn ?? null,
      [PREFERENCE_SETTING_KEYS.spendPauseUsd]: limits.pause ?? null,
    })
    const cards: Array<{ spentUsd: number; paused: boolean }> = []
    const contents: string[] = []
    const holds: boolean[] = []
    const spend = new SpendGuard({
      now: () => clock,
      ...bag,
      todayCost: () => cost,
      postCard: (content, payload) => {
        contents.push(content)
        cards.push({ spentUsd: payload.spentUsd, paused: payload.paused ?? false })
      },
      hold: (held) => holds.push(held),
    })
    return {
      spend,
      bag,
      cards,
      contents,
      holds,
      spendTo: (usd: number) => {
        cost = usd
        return spend.check()
      },
      nextDay: () => {
        clock += 24 * 60 * 60 * 1000
        cost = 0
      },
    }
  }

  it('warns once a day past the warning limit', () => {
    const g = guard({ warn: 5 })
    g.spendTo(4.9)
    expect(g.cards).toEqual([])
    g.spendTo(5.2)
    g.spendTo(6)
    expect(g.cards).toEqual([{ spentUsd: 5.2, paused: false }])
    expect(g.contents).toEqual(["Today's spend passed US$ 5.00"])
    expect(g.holds).toEqual([])
    g.nextDay()
    g.spendTo(5.5)
    expect(g.cards).toHaveLength(2)
  })

  it('holds every bot at the pause limit until the next day', () => {
    const g = guard({ warn: 5, pause: 20 })
    g.spendTo(6)
    const status = g.spendTo(20.5)
    expect(status).toMatchObject({ paused: true, warned: true, todayUsd: 20.5 })
    expect(g.cards).toEqual([
      { spentUsd: 6, paused: false },
      { spentUsd: 20.5, paused: true },
    ])
    expect(g.contents[1]).toBe("Bots paused: today's spend reached US$ 20.00")
    expect(g.holds).toEqual([true])
    g.spendTo(21)
    expect(g.cards).toHaveLength(2)
    g.nextDay()
    expect(g.spend.check()).toMatchObject({ paused: false, warned: false })
    expect(g.holds).toEqual([true, false])
  })

  it('jumping straight past both limits posts only the pause card', () => {
    const g = guard({ warn: 5, pause: 20 })
    g.spendTo(25)
    expect(g.cards).toEqual([{ spentUsd: 25, paused: true }])
  })

  it('a manual resume lets the bots work for the rest of the day', () => {
    const g = guard({ pause: 10 })
    g.spendTo(12)
    expect(g.holds).toEqual([true])
    expect(g.spend.resume()).toMatchObject({ paused: false, resumed: true })
    g.spendTo(30)
    expect(g.holds).toEqual([true, false])
    expect(g.cards).toHaveLength(1)
  })

  it('raising the limit releases the hold', () => {
    const g = guard({ pause: 10 })
    g.spendTo(12)
    g.bag.setSetting(PREFERENCE_SETTING_KEYS.spendPauseUsd, 50)
    expect(g.spend.check()).toMatchObject({ paused: false })
    expect(g.holds).toEqual([true, false])
  })

  it('restores the hold of today after a restart', () => {
    const g = guard({ pause: 10 })
    g.spendTo(12)
    const restarted = new SpendGuard({
      now: () => new Date(2026, 8, 26, 11, 0).getTime(),
      ...g.bag,
      todayCost: () => 12,
      postCard: () => {
        throw new Error('no second card')
      },
      hold: (held) => g.holds.push(held),
    })
    restarted.start()
    restarted.stop()
    expect(g.holds).toEqual([true, true])
  })
})
