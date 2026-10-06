import { BOARD_USER, type Bot } from '@milibot/shared'
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { useAppStore } from '@/features/workspace/store'

import { AssigneeStack } from './CardPeople'

const bot = (id: string, name: string) =>
  ({ id, name, status: 'idle', avatar: { shape: 'square', color: 'green', eyes: 'capsule' } }) as Bot

describe('AssigneeStack', () => {
  const bots = [bot('bot_1', 'Theo'), bot('bot_2', 'Lina'), bot('bot_3', 'Marco'), bot('bot_4', 'Nina')]
  beforeEach(() => useAppStore.setState({ bots: Object.fromEntries(bots.map((b) => [b.id, b])) }))

  it('rings only the user avatar, never a bot', () => {
    const { container } = render(<AssigneeStack assignees={['bot_1', BOARD_USER]} />)
    const [botSlot, userSlot] = Array.from(container.querySelectorAll('[role="img"] > span'))
    expect(botSlot?.querySelector('svg')).toBeTruthy()
    expect(botSlot?.querySelector('[class*="ring-"]')).toBeNull()
    expect(userSlot?.querySelector('.ring-2')).toBeTruthy()
  })

  it('shows the first three and counts the rest, naming everyone', () => {
    const { container, getByText } = render(
      <AssigneeStack assignees={['bot_1', 'bot_2', 'bot_3', 'bot_4', BOARD_USER]} size={20} max={3} />,
    )
    const stack = container.querySelector('[role="img"]')
    expect(stack?.getAttribute('aria-label')).toMatch(/^Theo, Lina, Marco, Nina, /)
    expect(stack?.querySelectorAll(':scope > span.flex')).toHaveLength(3)
    expect(getByText('+2')).toBeTruthy()
  })
})
