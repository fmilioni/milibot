import type { BoardCard } from '@milibot/shared'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@/features/workspace/store'

import { CardTile } from './BoardColumn'

const card: BoardCard = {
  id: 'bcd_1',
  boardId: 'brd_1',
  title: 'Live canvas',
  summary: 'Frames change while the bot draws.',
  status: 'doing',
  position: 0,
  dueDate: null,
  assignees: [],
  labelIds: [],
  createdByBotId: null,
  commentCount: 2,
  imageCount: 0,
  links: [
    {
      id: 'l1',
      kind: 'pr',
      ref: 'https://github.com/a/b/pull/23',
      label: '#23 feat: live canvas',
      url: 'https://github.com/a/b/pull/23',
      state: 'done',
      createdAt: 0,
    },
  ],
  statusChangedAt: 0,
  createdAt: 0,
  updatedAt: 0,
}

describe('CardTile', () => {
  beforeEach(() => useAppStore.setState({ bots: {} }))

  it('shows the pull request number and state, the comments and who works on it now', () => {
    useAppStore.setState({ bots: { bot_1: { id: 'bot_1', name: 'Theo' } as never } })
    render(<CardTile card={card} liveBot="bot_1" />)
    expect(screen.getByText('#23 · Merged')).toBeTruthy()
    expect(screen.getByRole('img', { name: '2 comments' })).toBeTruthy()
    expect(screen.getByText('Theo working now')).toBeTruthy()
  })

  it('opens from anywhere on it, while its menu acts without opening it', () => {
    const onCard = vi.fn()
    render(<CardTile card={card} onCard={onCard} />)
    fireEvent.click(screen.getByText('Frames change while the bot draws.'))
    expect(onCard).toHaveBeenLastCalledWith(card, 'open')

    fireEvent.click(screen.getByRole('button', { name: 'More options for “Live canvas”' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy ID' }))
    expect(onCard).toHaveBeenLastCalledWith(card, 'copy-id')
    expect(onCard).toHaveBeenCalledTimes(2)
  })

  it('is named by its title for the keyboard', () => {
    render(<CardTile card={card} onCard={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Live canvas' })).toBeTruthy()
  })
})
