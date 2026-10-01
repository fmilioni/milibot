import { describe, expect, it } from 'vitest'

import {
  advanceReveal,
  closeDanglingMarkdown,
  pruneChunks,
  REVEAL_FADE_MS,
  revealTarget,
  shouldAnimateReveal,
  snapToWordEnd,
} from './reveal'

/** Milliseconds until `length` characters arriving at once are fully revealed at `frameMs` per frame. */
function revealTime(length: number, frameMs = 1000 / 60): number {
  let shown = 0
  let elapsed = 0
  while (shown < length) {
    shown = advanceReveal(shown, length, frameMs)
    elapsed += frameMs
    if (elapsed > 60_000) throw new Error('reveal never finished')
  }
  return elapsed
}

describe('advanceReveal', () => {
  it('never overshoots or goes backwards', () => {
    expect(advanceReveal(10, 10, 16)).toBe(10)
    expect(advanceReveal(12, 10, 16)).toBe(10)
    const next = advanceReveal(0, 500, 16)
    expect(next).toBeGreaterThan(0)
    expect(next).toBeLessThan(500)
    expect(advanceReveal(0, 500, 0)).toBe(0)
  })

  it('types short replies at a readable pace', () => {
    const time = revealTime(60)
    expect(time).toBeGreaterThan(200)
    expect(time).toBeLessThan(700)
  })

  it('catches up with long replies arriving at once within ~2 s', () => {
    expect(revealTime(1200)).toBeLessThan(1600)
    expect(revealTime(3000)).toBeLessThan(2100)
    expect(revealTime(3000)).toBeGreaterThan(1000)
  })

  it('sweeps at an even pace instead of dumping most of the text in the first frames', () => {
    let shown = 0
    for (let i = 0; i < 6; i++) shown = advanceReveal(shown, 2000, 1000 / 60)
    expect(shown / 2000).toBeLessThan(0.15)
  })

  it('paces the same regardless of the frame rate', () => {
    let at60 = 0
    let at144 = 0
    for (let i = 0; i < 30; i++) at60 = advanceReveal(at60, 1500, 1000 / 60)
    for (let i = 0; i < 72; i++) at144 = advanceReveal(at144, 1500, 1000 / 144)
    expect(Math.abs(at60 - at144)).toBeLessThan(15)
  })

  it('keeps up with a live stream with only a small lag', () => {
    // 250 chars/s arriving in 50 ms deltas.
    let target = 0
    let shown = 0
    for (let frame = 0; frame < 300; frame++) {
      if (frame % 3 === 0) target += 12.5
      shown = advanceReveal(shown, target, 1000 / 60)
    }
    expect(target - shown).toBeLessThan(40)
  })

  it('does not jump after a long pause (hidden window)', () => {
    expect(advanceReveal(0, 5000, 10_000)).toBeLessThan(advanceReveal(0, 5000, 250) + 1)
  })
})

describe('revealTarget', () => {
  it('reveals everything once the stream is done', () => {
    expect(revealTarget('Hey wor', false)).toBe(7)
  })

  it('holds back a word still being streamed', () => {
    expect(revealTarget('Hey wor', true)).toBe(4)
    expect(revealTarget('Hey world ', true)).toBe(10)
    expect(revealTarget('x'.repeat(60), true)).toBe(60)
  })
})

describe('snapToWordEnd', () => {
  it('moves to the end of the current word', () => {
    expect(snapToWordEnd('Hey world friend', 5)).toBe(9)
    expect(snapToWordEnd('Hey world friend', 4)).toBe(4)
    expect(snapToWordEnd('Hey world friend', 0)).toBe(0)
    expect(snapToWordEnd('Hey world', 99)).toBe(9)
  })

  it('respects the limit', () => {
    expect(snapToWordEnd('Hey world', 5, 7)).toBe(7)
  })
})

describe('closeDanglingMarkdown', () => {
  it('closes bold and inline code cut in the middle', () => {
    expect(closeDanglingMarkdown('a **bold te')).toBe('a **bold te**')
    expect(closeDanglingMarkdown('run `apt up')).toBe('run `apt up`')
    expect(closeDanglingMarkdown('**bold** and `code`')).toBe('**bold** and `code`')
  })

  it('drops a bold opener with nothing after it', () => {
    expect(closeDanglingMarkdown('before **')).toBe('before ')
  })

  it('ignores markers inside code and earlier paragraphs', () => {
    expect(closeDanglingMarkdown('`a ** b` and more')).toBe('`a ** b` and more')
    expect(closeDanglingMarkdown('**x\n\nnew')).toBe('**x\n\nnew')
  })

  it('leaves an open fenced block alone', () => {
    const source = 'see:\n\n```bash\nsudo apt `update'
    expect(closeDanglingMarkdown(source)).toBe(source)
  })
})

describe('pruneChunks', () => {
  it('drops chunks whose fade is over and keeps identity when nothing changes', () => {
    const chunks = [
      { start: 0, born: 0 },
      { start: 10, born: 300 },
    ]
    expect(pruneChunks(chunks, 100)).toBe(chunks)
    expect(pruneChunks(chunks, REVEAL_FADE_MS + 1)).toEqual([{ start: 10, born: 300 }])
  })
})

describe('shouldAnimateReveal', () => {
  const now = 1_000_000
  it('animates live bot text only', () => {
    expect(shouldAnimateReveal({ authorType: 'bot', createdAt: 0, content: '' }, true, now)).toBe(true)
    expect(shouldAnimateReveal({ authorType: 'bot', createdAt: now - 1000, content: 'x' }, false, now)).toBe(
      true,
    )
    expect(
      shouldAnimateReveal({ authorType: 'bot', createdAt: now - 60_000, content: 'x' }, false, now),
    ).toBe(false)
    expect(shouldAnimateReveal({ authorType: 'user', createdAt: now, content: 'x' }, true, now)).toBe(false)
  })
})
