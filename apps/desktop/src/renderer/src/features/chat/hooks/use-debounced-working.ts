import { useEffect, useRef, useState } from 'react'

import type { WorkingCandidate } from '@/features/chat/lib/working'

/** Candidates that only became busy (no optimistic trigger) must stay so for `delayMs` to show. */
export function useDebouncedWorking(candidates: WorkingCandidate[], delayMs: number): string[] {
  // Every candidate seen, and whether it shows yet (decided when first seen: immediate, or after the delay).
  const [seen, setSeen] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  let current = seen
  const changed =
    candidates.some((c) => !seen.has(c.botId)) ||
    [...seen.keys()].some((id) => !candidates.some((c) => c.botId === id))
  if (changed) {
    current = new Map(candidates.map((c) => [c.botId, seen.get(c.botId) ?? c.immediate]))
    setSeen(current)
  }
  const visible = candidates.filter((c) => current.get(c.botId)).map((c) => c.botId)
  const waitingKey = candidates
    .filter((c) => !current.get(c.botId))
    .map((c) => c.botId)
    .join('\n')

  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  useEffect(() => {
    const waiting = new Set(waitingKey ? waitingKey.split('\n') : [])
    for (const [id, timer] of timers.current) {
      if (waiting.has(id)) continue
      clearTimeout(timer)
      timers.current.delete(id)
    }
    for (const id of waiting) {
      if (timers.current.has(id)) continue
      const show = () => {
        timers.current.delete(id)
        setSeen((map) => (map.has(id) ? new Map(map).set(id, true) : map))
      }
      timers.current.set(id, setTimeout(show, delayMs))
    }
  }, [waitingKey, delayMs])
  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
    }
  }, [])
  return visible
}
