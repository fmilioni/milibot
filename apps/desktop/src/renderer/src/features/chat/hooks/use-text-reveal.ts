import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'

import {
  advanceReveal,
  closeDanglingMarkdown,
  pruneChunks,
  type RevealChunk,
  revealTarget,
  snapToWordEnd,
} from '@/lib/reveal'

/** Messages still typing out, so the "working" row can wait for the text to finish. */
let revealing: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()

function setRevealing(messageId: string, active: boolean): void {
  if (revealing.has(messageId) === active) return
  const next = new Set(revealing)
  if (active) next.add(messageId)
  else next.delete(messageId)
  revealing = next
  for (const listener of listeners) listener()
}

export function useRevealingMessages(): ReadonlySet<string> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => revealing,
  )
}

interface Frame {
  length: number
  chunks: RevealChunk[]
}

export interface TextReveal {
  /** Markdown source to render (a prefix of the text, with dangling markers closed). */
  source: string
  chunks: RevealChunk[]
  /** Still streaming or still catching up. */
  active: boolean
}

/**
 * Reveals `text` progressively with a rAF loop. When `animate` is false (settled history, reduced
 * motion) the text is returned whole and nothing runs.
 */
export function useTextReveal(
  messageId: string,
  text: string,
  streaming: boolean,
  animate: boolean,
): TextReveal {
  const [frame, setFrame] = useState<Frame>(() => ({ length: animate ? 0 : text.length, chunks: [] }))
  const input = useRef({ text, streaming })
  useLayoutEffect(() => {
    input.current = { text, streaming }
  })
  const position = useRef(frame.length)
  const shown = useRef(frame)
  const raf = useRef(0)

  useEffect(() => {
    if (!animate || raf.current) return
    let last = performance.now()
    const tick = (now: number) => {
      const { text: current, streaming: live } = input.current
      const target = revealTarget(current, live)
      position.current = advanceReveal(Math.min(position.current, target), target, now - last)
      last = now
      const previous = shown.current
      const length = Math.min(
        current.length,
        Math.max(previous.length, snapToWordEnd(current, Math.floor(position.current), target)),
      )
      let chunks = pruneChunks(previous.chunks, now)
      if (length > previous.length) chunks = [...chunks, { start: previous.length, born: now }]
      if (length !== previous.length || chunks !== previous.chunks) {
        shown.current = { length, chunks }
        setFrame(shown.current)
      }
      raf.current = length < target || chunks.length > 0 ? requestAnimationFrame(tick) : 0
    }
    raf.current = requestAnimationFrame(tick)
  }, [animate, text, streaming])

  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current)
      raf.current = 0
    },
    [],
  )

  const length = animate ? Math.min(frame.length, text.length) : text.length
  const active = streaming || length < text.length

  useEffect(() => {
    setRevealing(messageId, animate && active)
    return () => setRevealing(messageId, false)
  }, [messageId, animate, active])

  if (!animate) return { source: text, chunks: [], active: streaming }
  return {
    source: length < text.length ? closeDanglingMarkdown(text.slice(0, length)) : text,
    chunks: frame.chunks,
    active,
  }
}
