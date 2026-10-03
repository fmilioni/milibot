import { BOARD_USER,type Bot } from '@milibot/shared'
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { useAppStore } from '@/features/workspace/store'

import { AssigneeStack } from './CardPeople'

const bot = {
  id: 'bot_1',
  name: 'Theo',
  status: 'idle',
  avatar: { shape: 'square', color: 'green', eyes: 'capsule' },
} as Bot

describe('AssigneeStack', () => {
  beforeEach(() => useAppStore.setState({ bots: { [bot.id]: bot } }))

  it('rings only the user avatar, never a bot', () => {
    const { container } = render(<AssigneeStack assignees={[bot.id, BOARD_USER]} />)
    const [botSlot, userSlot] = Array.from(container.querySelectorAll('[aria-label] > span'))
    expect(botSlot?.querySelector('svg')).toBeTruthy()
    expect(botSlot?.className).not.toMatch(/\bring-/)
    expect(userSlot?.className).toMatch(/\bring-2\b/)
  })
})
