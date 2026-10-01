import { useEffect, useLayoutEffect, useRef } from 'react'

import { isTypingTarget } from '@/lib/keyboard'
import { hasModKey } from '@/lib/platform'
import { type Size, stepZoom, type Viewport, zoomAt } from '@/lib/viewport'

/**
 * ⌘+ / ⌘− / ⌘0 (100%) / ⌘1 (fit) / ⇧⌘C (copy the selected frame) and Escape (deselect). The ⌘ ones (Ctrl
 * off macOS) work from the composer too, which keeps the focus; plain keys don't.
 */
export function useCanvasShortcuts(options: {
  viewport: Viewport | null
  size: Size
  setViewport: (viewport: Viewport) => void
  fit: () => void
  /** Null when nothing is selected. */
  copySelected: (() => void) | null
  /** Null while nothing should be deselected (no selection, or a menu or panel takes Escape). */
  deselect: (() => void) | null
}): void {
  const latest = useRef(options)
  useLayoutEffect(() => {
    latest.current = options
  })
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const { viewport, size, setViewport, fit, copySelected, deselect } = latest.current
      const mod = hasModKey(event)
      if (!viewport || (!mod && isTypingTarget(event.target))) return
      const mid = { x: size.width / 2, y: size.height / 2 }
      if (mod && !event.altKey) {
        const key = event.key
        if (key === '=' || key === '+') {
          event.preventDefault()
          setViewport(zoomAt(viewport, stepZoom(viewport.zoom, 1), mid))
        } else if (key === '-' || key === '_') {
          event.preventDefault()
          setViewport(zoomAt(viewport, stepZoom(viewport.zoom, -1), mid))
        } else if (key === '0') {
          event.preventDefault()
          setViewport(zoomAt(viewport, 1, mid))
        } else if (key === '1') {
          event.preventDefault()
          fit()
        } else if (event.shiftKey && key.toLowerCase() === 'c' && copySelected) {
          event.preventDefault()
          copySelected()
        }
        return
      }
      if (event.key === 'Escape') deselect?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
