import type { QuestionPayload } from '@milibot/shared'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PendingQuestions } from './PendingQuestions'

const PR = 'https://github.com/org/repo/pull/18'
const DOCS = 'https://docs.example.com/merge'
const LABEL_LINK = 'https://example.com/a'

const payload: QuestionPayload = {
  type: 'question',
  requestId: 'req_1',
  botId: 'bot_1',
  status: 'pending',
  questions: [
    {
      header: 'Merge',
      question: `Merge ${PR}?`,
      multiSelect: false,
      options: [
        { label: 'Merge', description: `Squash, as in ${DOCS}.`, recommended: true },
        { label: `Wait for ${LABEL_LINK}` },
      ],
    },
  ],
}

const openExternal = vi.fn(() => Promise.resolve())

function renderCard() {
  const onAnswer = vi.fn(() => Promise.resolve())
  render(
    <PendingQuestions
      payload={payload}
      bot={undefined}
      onAnswer={onAnswer}
      onDecline={() => Promise.resolve()}
    />,
  )
  return { onAnswer }
}

const radio = (name: RegExp) => screen.getByRole('radio', { name })

describe('PendingQuestions', () => {
  beforeEach(() => {
    openExternal.mockClear()
    Object.assign(window, { milibot: { openExternal } })
  })

  it('opens the links of the question and the options without picking or sending', () => {
    const { onAnswer } = renderCard()
    const checked = () => screen.getAllByRole('radio').map((r) => r.getAttribute('aria-checked'))
    const before = checked()
    for (const url of [PR, DOCS, LABEL_LINK]) {
      fireEvent.click(screen.getByRole('link', { name: url }))
      expect(openExternal).toHaveBeenLastCalledWith(url)
    }
    expect(openExternal).toHaveBeenCalledTimes(3)
    expect(checked()).toEqual(before)
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('keeps the options named by their text and picked by a click on the row', () => {
    renderCard()
    expect(radio(/^Merge Recommended$/).getAttribute('aria-describedby')).toBeTruthy()
    const wait = radio(new RegExp(`^Wait for ${LABEL_LINK}$`))
    expect(wait.getAttribute('aria-describedby')).toBeNull()
    fireEvent.click(wait)
    expect(wait.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('link', { name: LABEL_LINK }).closest('button')).toBeNull()
  })

  it('lets Enter on a focused link open it instead of sending', () => {
    const { onAnswer } = renderCard()
    expect(radio(/^Merge/).getAttribute('aria-checked')).toBe('true')
    const link = screen.getByRole('link', { name: PR })
    link.focus()
    expect(fireEvent.keyDown(link, { key: 'Enter' })).toBe(true)
    expect(onAnswer).not.toHaveBeenCalled()

    fireEvent.keyDown(link, { key: '2' })
    expect(radio(/^Wait for/).getAttribute('aria-checked')).toBe('true')

    fireEvent.keyDown(radio(/^Wait for/), { key: 'Enter' })
    expect(onAnswer).toHaveBeenCalledWith([{ selected: [`Wait for ${LABEL_LINK}`] }])
  })
})
