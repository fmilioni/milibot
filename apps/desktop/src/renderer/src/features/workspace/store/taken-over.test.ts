import { afterEach, describe, expect, it } from 'vitest'

import { applyScreenEvent, takenOverHere } from './taken-over'

const screen = (botId: string, control: 'user' | 'bot' | 'idle') =>
  ({ type: 'bot.screen', payload: { botId, control, paused: control === 'user', busy: false } }) as const

describe('applyScreenEvent', () => {
  afterEach(() => takenOverHere.clear())

  it('forgets a screen once it is given back, whoever gave it back', () => {
    takenOverHere.add('ws1:bot_1')
    takenOverHere.add('ws1:bot_2')
    takenOverHere.add('ws2:bot_1')
    applyScreenEvent('ws1', screen('bot_1', 'user'))
    expect([...takenOverHere]).toEqual(['ws1:bot_1', 'ws1:bot_2', 'ws2:bot_1'])
    applyScreenEvent('ws1', screen('bot_1', 'idle'))
    applyScreenEvent('ws1', screen('bot_2', 'bot'))
    expect([...takenOverHere]).toEqual(['ws2:bot_1'])
  })
})
