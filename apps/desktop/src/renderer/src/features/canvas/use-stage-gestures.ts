import type { DesignFrame, PlacedFrame } from '@milibot/shared'
import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

import { dropSpot, hitTest, SNAP_PX, snapPosition } from '@/features/canvas/lib/canvas'
import { isTypingTarget } from '@/lib/keyboard'
import { readPref, writePref } from '@/lib/prefs'
import { type Point, toWorld, type Viewport, wheelZoomFactor, zoomAt } from '@/lib/viewport'

const DRAG_THRESHOLD_PX = 3
const DRAG_HINT_KEY = 'milibot.canvas.dragged'

export interface FrameDrag {
  frameId: string
  pointerId: number
  startX: number
  startY: number
  originX: number
  originY: number
  moved: boolean
  x: number
  y: number
  guides: { x: number[]; y: number[] }
  spot: { x: number; y: number; pushed: boolean }
}

interface Pan {
  pointerId: number
  startX: number
  startY: number
  origin: Viewport
}

/**
 * Pan and zoom of the stage (trackpad scroll, pinch or ⌘+wheel, space or middle button drags), selection
 * by click, and dragging frames by their label with snapping and the daemon's push preview.
 */
export function useStageGestures({
  ref,
  viewport: v,
  rects,
  onViewport,
  onSelect,
  onMove,
}: {
  ref: RefObject<HTMLDivElement | null>
  viewport: Viewport
  rects: readonly PlacedFrame[]
  onViewport: (viewport: Viewport) => void
  onSelect: (frameId: string | null) => void
  onMove: (frameId: string, x: number, y: number) => void
}) {
  const [drag, setDrag] = useState<FrameDrag | null>(null)
  const [pan, setPan] = useState<Pan | null>(null)
  const [space, setSpace] = useState(false)
  const [dragged, setDragged] = useState(() => readPref(DRAG_HINT_KEY) === '1')
  const vRef = useRef(v)
  useLayoutEffect(() => {
    vRef.current = v
  })

  // Trackpad scroll pans; pinch (ctrl+wheel) and ⌘+wheel zoom around the cursor. Not passive: the page
  // itself must never scroll or zoom.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const current = vRef.current
      if (event.ctrlKey || event.metaKey) {
        const box = el.getBoundingClientRect()
        const anchor = { x: event.clientX - box.left, y: event.clientY - box.top }
        onViewport(zoomAt(current, current.zoom * wheelZoomFactor(event.deltaY, event.deltaMode), anchor))
        return
      }
      const unit = event.deltaMode === 1 ? 16 : 1
      onViewport({ ...current, x: current.x - event.deltaX * unit, y: current.y - event.deltaY * unit })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [ref, onViewport])

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code === 'Space' && !isTypingTarget(event.target)) {
        event.preventDefault()
        setSpace(true)
      }
    }
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpace(false)
    }
    const blur = () => setSpace(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  /** The world point under a pointer. */
  const worldAt = (event: { clientX: number; clientY: number }): Point => {
    const box = ref.current?.getBoundingClientRect()
    return toWorld(v, { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) })
  }

  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pan && event.pointerId === pan.pointerId) setPan(null)
  }

  const stageHandlers = {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button === 1 || (event.button === 0 && space)) {
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        setPan({ pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: v })
        return
      }
      if (event.button !== 0) return
      ref.current?.focus({ preventScroll: true })
      onSelect(hitTest(rects, worldAt(event)))
    },
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (pan && event.pointerId === pan.pointerId)
        onViewport({
          ...pan.origin,
          x: pan.origin.x + event.clientX - pan.startX,
          y: pan.origin.y + event.clientY - pan.startY,
        })
    },
    onPointerUp: endPan,
    onPointerCancel: endPan,
  }

  const onLabelPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
    const rect = rects.find((r) => r.id === drag.frameId)
    if (!rect) return
    const others = rects.filter((r) => r.id !== drag.frameId)
    const raw = { ...rect, x: drag.originX + dx / v.zoom, y: drag.originY + dy / v.zoom }
    const snapped = event.altKey
      ? { x: Math.round(raw.x), y: Math.round(raw.y), guides: { x: [], y: [] } }
      : snapPosition(raw, others, SNAP_PX / v.zoom)
    const spot = dropSpot({ ...rect, x: snapped.x, y: snapped.y }, rects)
    setDrag({ ...drag, moved: true, x: snapped.x, y: snapped.y, guides: snapped.guides, spot })
  }

  const onLabelPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    setDrag(null)
    if (!drag.moved) return
    if (!dragged) {
      setDragged(true)
      writePref(DRAG_HINT_KEY, '1')
    }
    onMove(drag.frameId, drag.x, drag.y)
  }

  const labelHandlers = (frame: DesignFrame) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || space) return
      event.stopPropagation()
      event.preventDefault()
      ref.current?.focus({ preventScroll: true })
      onSelect(frame.id)
      event.currentTarget.setPointerCapture(event.pointerId)
      setDrag({
        frameId: frame.id,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: frame.x,
        originY: frame.y,
        moved: false,
        x: frame.x,
        y: frame.y,
        guides: { x: [], y: [] },
        spot: { x: frame.x, y: frame.y, pushed: false },
      })
    },
    onPointerMove: onLabelPointerMove,
    onPointerUp: onLabelPointerUp,
    onPointerCancel: onLabelPointerUp,
  })

  return { drag, pan, space, dragged, worldAt, stageHandlers, labelHandlers }
}
