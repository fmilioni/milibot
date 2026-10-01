import { render, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { BotCursors, type CursorEntry, useKnownEntries } from './BotCursor'

const entry = (visible = true): CursorEntry => ({
  botId: 'bot_1',
  name: 'Maestro',
  color: '#8b93ff',
  goal: { key: 'frame_1', box: { x: 0, y: 0, width: 100, height: 80 } },
  visible,
  lastActivity: null,
})

describe('BotCursors', () => {
  it('renders once per parent render when the rebuilt entries carry the same content', () => {
    let renders = 0
    const { rerender } = renderHook(
      ({ entries }) => {
        renders++
        return useKnownEntries(entries)
      },
      { initialProps: { entries: [entry()] } },
    )
    renders = 0
    rerender({ entries: [entry()] })
    rerender({ entries: [entry()] })
    expect(renders).toBe(2)
    rerender({ entries: [entry(false)] })
    expect(renders).toBe(4)
  })

  it('keeps a bot that left, hidden, so its cursor fades out', () => {
    const { container, rerender } = render(
      <BotCursors entries={[entry()]} viewport={{ x: 0, y: 0, zoom: 1 }} reduced />,
    )
    rerender(<BotCursors entries={[]} viewport={{ x: 0, y: 0, zoom: 1 }} reduced />)
    expect(container.textContent).toContain('Maestro')
  })
})
