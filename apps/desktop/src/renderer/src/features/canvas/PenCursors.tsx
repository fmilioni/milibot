import type { PlacedFrame } from '@milibot/shared'
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'

import { type Point, pointAlong } from '@/features/canvas/lib/bot-cursor'
import type { Viewport } from '@/lib/viewport'

/** A bit longer than the daemon's 250 ms between versions, so the pen never stops. */
const TRAIL_MS = 320

interface Trail {
  points: Point[]
  start: number
}

export interface PenEntry {
  draftId: string
  name: string
  color: string
}

export function usePenTrails() {
  const trails = useRef(new Map<string, Trail>())
  const push = useCallback((draftId: string, points: Point[]) => {
    trails.current.set(draftId, { points, start: Date.now() })
  }, [])
  return { trails, push }
}

export function PenCursors({
  pens,
  rects,
  trails,
  viewport,
  reduced,
}: {
  pens: PenEntry[]
  rects: PlacedFrame[]
  trails: React.RefObject<Map<string, Trail>>
  viewport: Viewport
  reduced: boolean
}) {
  const nodes = useRef(new Map<string, HTMLDivElement>())
  const latest = useRef({ rects, viewport, reduced })
  useLayoutEffect(() => {
    latest.current = { rects, viewport, reduced }
  })

  const active = pens.length > 0
  useEffect(() => {
    if (!active) return
    let frame = 0
    const step = () => {
      const { rects: placed, viewport: v, reduced: still } = latest.current
      const now = Date.now()
      for (const [draftId, node] of nodes.current) {
        const trail = trails.current?.get(draftId)
        const rect = placed.find((r) => r.id === draftId)
        const at = trail ? pointAlong(trail.points, still ? 1 : (now - trail.start) / TRAIL_MS) : null
        if (!at || !rect) {
          node.style.opacity = '0'
          continue
        }
        node.style.opacity = '1'
        node.style.transform = `translate3d(${(rect.x + at.x) * v.zoom + v.x}px, ${(rect.y + at.y) * v.zoom + v.y}px, 0)`
      }
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [active, trails])

  return pens.map((pen) => (
    <div
      key={pen.draftId}
      ref={(node) => {
        if (node) nodes.current.set(pen.draftId, node)
        else nodes.current.delete(pen.draftId)
      }}
      aria-hidden
      className="pointer-events-none absolute top-0 left-0 transition-opacity duration-300 will-change-transform"
      style={{ opacity: 0 }}
    >
      <svg
        width="22"
        height="22"
        viewBox="0 0 22 22"
        className="absolute -top-[21px] -left-[1px] drop-shadow-sm"
      >
        <path
          d="M1.5 20.5 4 13 15.5 1.5a2.1 2.1 0 0 1 3 0l2 2a2.1 2.1 0 0 1 0 3L9 18Z"
          fill={pen.color}
          stroke="white"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
        <path d="M4 13 9 18" stroke="white" strokeWidth="1.2" />
      </svg>
      <span
        className="absolute top-[4px] left-[12px] rounded-[4px] px-1.5 py-px text-xs leading-[15px] font-medium whitespace-nowrap text-white shadow-[0_1px_3px_rgba(0,0,0,0.18)]"
        style={{ background: pen.color }}
      >
        {pen.name}
      </span>
    </div>
  ))
}
