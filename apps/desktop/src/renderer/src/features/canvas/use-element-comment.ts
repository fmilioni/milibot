import type { DesignFrame, PlacedFrame } from '@milibot/shared'
import { type PointerEvent as ReactPointerEvent, useEffect, useEffectEvent, useRef, useState } from 'react'

import type { Box, Point } from '@/features/canvas/lib/bot-cursor'
import { hitTest } from '@/features/canvas/lib/canvas'
import { boxOf, childAt, elementAt, parentOf, trailOf } from '@/features/canvas/lib/element-pick'
import { isTypingTarget } from '@/lib/keyboard'

import { frameDocument } from './frame-iframes'

/** The element a comment is about. */
export interface PickedElement {
  frameId: string
  element: Element
  /** Where it is in its frame's page (page pixels). */
  box: Box
  /** The children left on the way up (nearest first), to come back down with Alt+↓. */
  below: Element[]
  /** Where it was clicked (page pixels): going down without a way back heads there. */
  point: Point
}

interface Hit {
  frameId: string
  element: Element
  point: Point
}

const pick = (frameId: string, element: Element, point: Point, below: Element[] = []): PickedElement => ({
  frameId,
  element,
  box: boxOf(element),
  below,
  point,
})

/** The same place in a reloaded page (by position from the top), or null when it is gone. */
function relocate(element: Element, doc: Document): Element | null {
  let at: Element | null = doc.body
  for (const el of trailOf(element)) {
    const index = Array.prototype.indexOf.call(el.parentElement?.children ?? [], el)
    at = at?.children[index] ?? null
    if (!at || at.tagName !== el.tagName) return null
  }
  return at === doc.body ? null : at
}

/**
 * Pointing at an element of a frame to comment on it: while Alt is held (or the Comment tool is on) the
 * element under the pointer is outlined, and a click picks it instead of selecting the frame. A click inside
 * the picked element goes one level down toward the pointer; Alt+↑ / Alt+↓ go to the parent and back; Escape
 * lets go. Art frames and frames a bot is rewriting are not pointable.
 */
export function useElementComment({
  enabled,
  tool,
  rects,
  frames,
  replaced,
  worldAt,
}: {
  /** There is a conversation to send comments to. */
  enabled: boolean
  tool: boolean
  rects: readonly PlacedFrame[]
  frames: readonly DesignFrame[]
  replaced: ReadonlySet<string>
  worldAt: (event: { clientX: number; clientY: number }) => Point
}) {
  const [alt, setAlt] = useState(false)
  const [hover, setHover] = useState<{ frameId: string; element: Element; box: Box } | null>(null)
  const [picked, setPicked] = useState<PickedElement | null>(null)
  const pointer = useRef<{ clientX: number; clientY: number } | null>(null)
  const active = enabled && (tool || alt)
  if (!active && hover) setHover(null)

  const locate = (at: { clientX: number; clientY: number }): Hit | null => {
    const world = worldAt(at)
    const frameId = hitTest(rects, world)
    const frame = frameId ? frames.find((f) => f.id === frameId) : undefined
    const rect = frameId ? rects.find((r) => r.id === frameId) : undefined
    if (!frameId || !frame || !rect || frame.art || replaced.has(frameId)) return null
    const doc = frameDocument(frameId)
    const point = { x: world.x - rect.x, y: world.y - rect.y }
    const element = doc ? elementAt(doc, point) : null
    return element ? { frameId, element, point } : null
  }

  const hoverAt = (at: { clientX: number; clientY: number } | null) => {
    const hit = at && locate(at)
    if (!hit) {
      if (hover) setHover(null)
      return
    }
    if (hover?.element !== hit.element)
      setHover({ frameId: hit.frameId, element: hit.element, box: boxOf(hit.element) })
  }

  const up = () => {
    const parent = picked && parentOf(picked.element)
    if (picked && parent)
      setPicked(pick(picked.frameId, parent, picked.point, [picked.element, ...picked.below]))
  }

  const down = () => {
    if (!picked) return
    const [next, ...rest] = picked.below
    const child = next ?? childAt(picked.element, picked.point)
    if (child) setPicked(pick(picked.frameId, child, picked.point, next ? rest : []))
  }

  const onAltKey = useEffectEvent((event: KeyboardEvent, down: boolean) => {
    // Linux shows the window's hidden menu bar when Alt is released: keep it hidden while Alt points.
    if (enabled && (pointer.current || tool || picked)) event.preventDefault()
    setAlt(down)
    if (down && enabled) hoverAt(pointer.current)
  })

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (!picked) return
    if (event.key === 'Escape' && !isTypingTarget(event.target)) {
      event.preventDefault()
      event.stopPropagation()
      setPicked(null)
    } else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'ArrowUp') up()
      else down()
    }
  })

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Alt') onAltKey(event, true)
      else onKey(event)
    }
    const keyup = (event: KeyboardEvent) => {
      if (event.key === 'Alt') onAltKey(event, false)
    }
    const blur = () => setAlt(false)
    window.addEventListener('keydown', keydown, true)
    window.addEventListener('keyup', keyup, true)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', keydown, true)
      window.removeEventListener('keyup', keyup, true)
      window.removeEventListener('blur', blur)
    }
  }, [])

  /** Picks one of the picked element's ancestors (or itself) from its trail. */
  const pickInTrail = (element: Element) => {
    if (!picked || element === picked.element) return
    const trail = trailOf(picked.element)
    const at = trail.indexOf(element)
    if (at < 0) return
    setPicked(pick(picked.frameId, element, picked.point, [...trail.slice(at + 1), ...picked.below]))
  }

  /** A pointer down while pointing: true when it was taken (never selects the frame or pans). */
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>, space: boolean): boolean => {
    if (!active || event.button !== 0 || space) return false
    event.preventDefault()
    const hit = locate(event)
    if (!hit) {
      setPicked(null)
      return true
    }
    const inside =
      picked?.frameId === hit.frameId &&
      picked.element !== hit.element &&
      picked.element.contains(hit.element)
    if (inside) {
      let child = hit.element
      while (child.parentElement && child.parentElement !== picked.element) child = child.parentElement
      setPicked(pick(hit.frameId, child, hit.point))
    } else if (picked?.element !== hit.element) setPicked(pick(hit.frameId, hit.element, hit.point))
    return true
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointer.current = { clientX: event.clientX, clientY: event.clientY }
    if (active) hoverAt(pointer.current)
  }

  const onPointerLeave = () => {
    pointer.current = null
    if (hover) setHover(null)
  }

  /** A frame's page loaded again: follow the picked element into it, or let go when it is gone. */
  const onFrameLoad = (frameId: string) => {
    if (hover?.frameId === frameId) setHover(null)
    if (picked?.frameId !== frameId) return
    const doc = frameDocument(frameId)
    const element = picked.element.isConnected ? picked.element : doc && relocate(picked.element, doc)
    if (!element) setPicked(null)
    else
      setPicked({
        ...picked,
        element,
        box: boxOf(element),
        below: element === picked.element ? picked.below : [],
      })
  }

  return {
    active,
    hover: active ? hover : null,
    picked,
    close: () => setPicked(null),
    up,
    down,
    pickInTrail,
    onPointerDown,
    onPointerMove,
    onPointerLeave,
    onFrameLoad,
  }
}
