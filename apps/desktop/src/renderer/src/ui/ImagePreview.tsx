import { X } from 'lucide-react'
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/cn'
import { clampPan, fitImage, initialImageViewport, toggleZoomAt } from '@/lib/image-view'
import { isTypingTarget } from '@/lib/keyboard'
import { hasModKey } from '@/lib/platform'
import { type Size, stepZoom, type Viewport, wheelZoomFactor, zoomAt } from '@/lib/viewport'

import { ZoomControls } from './ZoomControls'

const DRAG_THRESHOLD_PX = 3

interface Pan {
  pointerId: number
  startX: number
  startY: number
  origin: Viewport
  moved: boolean
  onImage: boolean
}

/**
 * An image over the whole window with zoom (pinch, ⌘/Ctrl+scroll, double click, the controls, ⌘+ ⌘− ⌘0) and
 * pan (scroll or drag). A click outside the image or Escape closes it.
 */
export function ImagePreview({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  const { t } = useTranslation()
  const stageRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const [stage, setStage] = useState<Size | null>(null)
  const [image, setImage] = useState<Size | null>(null)
  const [viewport, setViewport] = useState<Viewport | null>(null)
  const [pan, setPan] = useState<Pan | null>(null)
  const latest = useRef({ stage, image, viewport, onClose })
  useLayoutEffect(() => {
    latest.current = { stage, image, viewport, onClose }
  })
  const [fitted, setFitted] = useState<{ image: Size; stage: Size } | null>(null)
  if (image && stage && (fitted?.image !== image || fitted.stage !== stage)) {
    setFitted({ image, stage })
    setViewport((current) => (current ? clampPan(current, image, stage) : initialImageViewport(image, stage)))
  }

  const apply = useCallback((next: Viewport) => {
    const { image: size, stage: box } = latest.current
    if (size && box) setViewport(clampPan(next, size, box))
  }, [])

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setStage({ width: el.clientWidth, height: el.clientHeight }))
    observer.observe(el)
    el.focus({ preventScroll: true })
    return () => observer.disconnect()
  }, [])

  // Not passive: the page behind must never scroll or zoom.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const current = latest.current.viewport
      if (!current) return
      if (event.ctrlKey || event.metaKey) {
        const box = el.getBoundingClientRect()
        const anchor = { x: event.clientX - box.left, y: event.clientY - box.top }
        apply(zoomAt(current, current.zoom * wheelZoomFactor(event.deltaY, event.deltaMode), anchor))
        return
      }
      const unit = event.deltaMode === 1 ? 16 : 1
      apply({ ...current, x: current.x - event.deltaX * unit, y: current.y - event.deltaY * unit })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [apply])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        latest.current.onClose()
        return
      }
      const { viewport: current, stage: box } = latest.current
      if (!current || !box || event.altKey || (!hasModKey(event) && isTypingTarget(event.target))) return
      const mid = { x: box.width / 2, y: box.height / 2 }
      const zoom =
        event.key === '=' || event.key === '+'
          ? stepZoom(current.zoom, 1)
          : event.key === '-' || event.key === '_'
            ? stepZoom(current.zoom, -1)
            : event.key === '0'
              ? 1
              : null
      if (zoom === null) return
      event.preventDefault()
      event.stopPropagation()
      apply(zoomAt(current, zoom, mid))
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [apply])

  const zoomAtCenter = (zoom: number) => {
    if (viewport && stage) apply(zoomAt(viewport, zoom, { x: stage.width / 2, y: stage.height / 2 }))
  }

  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pan || event.pointerId !== pan.pointerId) return
    setPan(null)
    if (event.type === 'pointerup' && !pan.moved && !pan.onImage) onClose()
  }

  return createPortal(
    <div
      ref={stageRef}
      role="dialog"
      aria-modal
      aria-label={name}
      tabIndex={-1}
      onPointerDown={(event) => {
        if (event.button !== 0 || !viewport) return
        setPan({
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          origin: viewport,
          moved: false,
          onImage: event.target === imageRef.current,
        })
      }}
      onPointerMove={(event) => {
        if (!pan || event.pointerId !== pan.pointerId) return
        const dx = event.clientX - pan.startX
        const dy = event.clientY - pan.startY
        if (!pan.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
        // Captured only once it drags, so a plain click or double click keeps its own target.
        if (!pan.moved) {
          event.currentTarget.setPointerCapture(event.pointerId)
          setPan({ ...pan, moved: true })
        }
        apply({ ...pan.origin, x: pan.origin.x + dx, y: pan.origin.y + dy })
      }}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onDoubleClick={(event) => {
        if (event.target !== imageRef.current || !viewport || !image || !stage) return
        const box = event.currentTarget.getBoundingClientRect()
        apply(
          toggleZoomAt(viewport, { x: event.clientX - box.left, y: event.clientY - box.top }, image, stage),
        )
      }}
      className={cn(
        'no-drag fixed inset-0 z-preview overflow-hidden bg-scrim-strong outline-none',
        pan?.moved ? 'cursor-grabbing' : '',
      )}
    >
      <img
        ref={imageRef}
        src={src}
        alt={name}
        draggable={false}
        onLoad={(event) =>
          setImage({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
        }
        className={cn(
          'absolute top-0 left-0 block max-w-none rounded-lg border border-border shadow-[0_20px_50px_rgba(0,0,0,0.4)] select-none',
          pan?.moved ? '' : 'cursor-grab',
        )}
        style={
          viewport && image
            ? {
                left: viewport.x,
                top: viewport.y,
                width: image.width * viewport.zoom,
                height: image.height * viewport.zoom,
              }
            : { visibility: 'hidden' }
        }
      />
      <button
        type="button"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={onClose}
        aria-label={t('common.close')}
        className="focus-ring absolute top-4 right-4 flex size-8 items-center justify-center rounded-full border border-border bg-surface-2 text-fg-secondary shadow-[0_2px_6px_rgba(0,0,0,0.2)] hover:bg-surface-3 hover:text-fg"
      >
        <X size={16} />
      </button>
      {viewport && image && stage && (
        <ZoomControls
          className="absolute bottom-4 left-1/2 -translate-x-1/2"
          zoom={viewport.zoom}
          onStep={(direction) => zoomAtCenter(stepZoom(viewport.zoom, direction))}
          onActualSize={() => zoomAtCenter(1)}
          onFit={() => apply(fitImage(image, stage))}
        />
      )}
    </div>,
    document.body,
  )
}
