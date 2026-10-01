import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { useBlobSrc } from '@/features/workspace/use-blob-src'
import { useReducedMotion } from '@/features/workspace/use-reduced-motion'
import { type ClickMark, markerSize, markPercent, SCREEN_H, SCREEN_W } from '@/lib/click-mark'
import { cn } from '@/lib/cn'

/** macOS-style arrow; its tip is at (1, 1) of the 14×21 box. */
const ARROW = 'M1 1 L1 17 L5 13.2 L8 20 L10.6 18.9 L7.7 12.3 L13 12.3 Z'

/** Arrow pointing up-left with its tip exactly on the point (the box extends right and down). */
function Cursor({ size }: { size: number }) {
  const unit = size / 21
  const outline = size >= 20 ? 1.5 : 1
  return (
    <svg
      width={14 * unit}
      height={size}
      viewBox="0 0 14 21"
      aria-hidden
      className="absolute drop-shadow-[0_1.5px_2px_rgba(0,0,0,0.5)]"
      style={{ left: -unit, top: -unit }}
    >
      <path d={ARROW} fill="#FFFFFF" stroke="#111318" strokeWidth={outline / unit} strokeLinejoin="round" />
    </svg>
  )
}

/**
 * Where an action touched the screen, over an image of the whole 1280x800 desktop: an arrow cursor
 * whose tip sits on the point (sized to the rendered image unless `size` is given) with a pulse ring
 * centered on the tip; drags get a start→end arrow, double/right/middle clicks a small badge. The
 * screenshot may be from right after the action.
 */
function ClickMarkerOverlay({ mark, size: fixedSize }: { mark: ClickMark; size?: number }) {
  const { t } = useTranslation()
  const box = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)
  useEffect(() => {
    const el = box.current
    if (!el || fixedSize) return
    const observer = new ResizeObserver(() => setHeight(el.clientHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [fixedSize])
  const size = fixedSize ?? markerSize(height)
  const ring = Math.round(size * 1.2)
  const ringStyle = { width: ring, height: ring, left: -ring / 2, top: -ring / 2 }
  const reduced = useReducedMotion()
  const arrowId = useId()
  const end = mark.kind === 'drag' && mark.toX !== undefined && mark.toY !== undefined
  const at = markPercent(end ? (mark.toX as number) : mark.x, end ? (mark.toY as number) : mark.y)
  const badge =
    mark.kind === 'double_click'
      ? t('screenshot.double')
      : mark.kind === 'right_click'
        ? t('screenshot.right')
        : mark.kind === 'middle_click'
          ? t('screenshot.middle')
          : null
  return (
    <div ref={box} className="pointer-events-none absolute inset-0">
      {end && (
        <svg
          viewBox={`0 0 ${SCREEN_W} ${SCREEN_H}`}
          preserveAspectRatio="none"
          className="absolute inset-0 size-full"
          aria-hidden
        >
          <defs>
            <marker
              id={arrowId}
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto"
            >
              <path d="M0 0L10 5L0 10z" fill="var(--danger)" />
            </marker>
          </defs>
          <line
            x1={mark.x}
            y1={mark.y}
            x2={mark.toX}
            y2={mark.toY}
            stroke="var(--danger)"
            strokeWidth={3}
            strokeDasharray="8 6"
            vectorEffect="non-scaling-stroke"
            markerEnd={`url(#${arrowId})`}
          />
          <circle cx={mark.x} cy={mark.y} r={6} fill="var(--danger)" vectorEffect="non-scaling-stroke" />
        </svg>
      )}
      <div className="absolute" style={{ left: `${at.left}%`, top: `${at.top}%` }}>
        <span
          className={cn(
            'absolute rounded-full border-danger bg-danger/25',
            size >= 20 ? 'border-2' : 'border',
          )}
          style={ringStyle}
          aria-hidden
        />
        {!reduced && (
          <span className="absolute animate-ping rounded-full bg-danger/40" style={ringStyle} aria-hidden />
        )}
        <Cursor size={size} />
        {badge && (
          <span
            className="absolute rounded-[4px] bg-[#111318E6] px-1 py-px font-mono text-2xs leading-3 font-semibold whitespace-nowrap text-white"
            style={{ left: size * 0.7, top: size * 0.75 }}
          >
            {badge}
          </span>
        )}
      </div>
    </div>
  )
}

/** Screenshot thumbnail (optionally with the click marker) that opens a full-size view. */
export function Screenshot({
  sha,
  mark,
  className = 'w-40',
  zoomable = true,
}: {
  sha: string
  mark?: ClickMark | null
  className?: string
  zoomable?: boolean
}) {
  const { t } = useTranslation()
  const src = useBlobSrc(sha)
  const [zoomed, setZoomed] = useState(false)

  useEffect(() => {
    if (!zoomed) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setZoomed(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [zoomed])

  if (!src) return <div className={`aspect-[1280/800] animate-pulse rounded-md bg-surface-3 ${className}`} />
  const image = (
    <span className="relative block">
      <img src={src} alt="" className="block w-full rounded-[5px]" draggable={false} />
      {mark && <ClickMarkerOverlay mark={mark} />}
    </span>
  )
  return (
    <>
      {zoomable ? (
        <button
          type="button"
          onClick={() => setZoomed(true)}
          aria-label={t('panels.vm.openScreenshot')}
          className={`focus-ring shrink-0 rounded-md border border-border ${className}`}
        >
          {image}
        </button>
      ) : (
        <span className={`block shrink-0 rounded-md border border-border ${className}`}>{image}</span>
      )}
      {zoomed &&
        createPortal(
          <div
            role="dialog"
            aria-label={t('panels.vm.screenshot')}
            onClick={() => setZoomed(false)}
            className="no-drag fixed inset-0 z-preview flex items-center justify-center bg-scrim-strong p-8"
          >
            <span className="relative block max-h-full max-w-full rounded-lg border border-border shadow-[0_20px_50px_rgba(0,0,0,0.4)]">
              <img src={src} alt="" className="block max-h-[calc(100vh-4rem)] max-w-full rounded-lg" />
              {mark && <ClickMarkerOverlay mark={mark} size={36} />}
            </span>
          </div>,
          document.body,
        )}
    </>
  )
}
