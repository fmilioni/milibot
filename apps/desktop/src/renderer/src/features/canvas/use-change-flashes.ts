import { useCallback, useEffect, useRef, useState } from 'react'

import type { Box } from '@/features/canvas/lib/bot-cursor'
import { CHANGE_FLASH_MS } from '@/features/canvas/lib/change-flash'

export interface Flash {
  /** New per flash: restarts the animation when the same frame changes again. */
  id: number
  boxes: Box[]
}

/** The changed elements outlined per frame, each set dropped `CHANGE_FLASH_MS` after it appeared. */
export function useChangeFlashes() {
  const [flashes, setFlashes] = useState<Record<string, Flash | undefined>>({})
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const lastId = useRef(0)

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
    }
  }, [])

  const flash = useCallback((frameId: string, boxes: Box[]) => {
    const id = ++lastId.current
    setFlashes((current) => ({ ...current, [frameId]: { id, boxes } }))
    clearTimeout(timers.current.get(frameId))
    timers.current.set(
      frameId,
      setTimeout(() => {
        timers.current.delete(frameId)
        setFlashes((current) => {
          if (current[frameId]?.id !== id) return current
          const next = { ...current }
          delete next[frameId]
          return next
        })
      }, CHANGE_FLASH_MS),
    )
  }, [])

  return { flashes, flash }
}
