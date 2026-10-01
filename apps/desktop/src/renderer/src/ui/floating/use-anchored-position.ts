import { type RefObject, useLayoutEffect, useRef, useState } from 'react'

import type { Size } from '@/lib/tooltip'

function sameShape(a: object, b: object): boolean {
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => (a as Record<string, unknown>)[key] === (b as Record<string, unknown>)[key])
  )
}

/**
 * Places a floating element from its measured size before each paint: `place` gets the element (its size;
 * read the anchor's rect there too) and the viewport. `null` until measured, and again while not `open`, so
 * the element renders hidden first (`FloatingPortal`). `place` is usually a fresh closure, so it runs after every
 * render (content changes are followed); an unchanged result keeps the previous object.
 */
export function useAnchoredPosition<P extends object, E extends HTMLElement = HTMLDivElement>(
  place: (floating: E, viewport: Size) => P,
  open = true,
): { ref: RefObject<E | null>; position: P | null } {
  const ref = useRef<E>(null)
  const [position, setPosition] = useState<P | null>(null)
  if (!open && position !== null) setPosition(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!open || !el) return
    const next = place(el, { width: window.innerWidth, height: window.innerHeight })
    setPosition((prev) => (prev && sameShape(prev, next) ? prev : next))
  }, [open, place])

  return { ref, position }
}
