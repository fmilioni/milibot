import { memo, useEffect, useRef, useState } from 'react'

import {
  type Box,
  changedRegion,
  type ElementShot,
  type PenMark,
  penTrail,
  type Point,
  snapshotPage,
} from '@/features/canvas/lib/bot-cursor'
import { NO_PAGE_LAYERS, offerPage, pageLoaded } from '@/features/canvas/lib/design-drafts'

/**
 * The page of a frame still being written. Each new version loads in a hidden iframe on top of the shown one
 * and replaces it once loaded, so the frame grows without flashing blank between versions. Versions that
 * arrive while one loads wait (only the newest), so a page slower to load than the updates still grows.
 */
export const DraftPage = memo(function DraftPage({
  html,
  title,
  width,
  height,
  auto,
  onMeasure,
  onChange,
  onPen,
}: {
  html: string
  title: string
  width: number
  height: number
  auto: boolean
  onMeasure: (height: number) => void
  /** Where the newly shown version differs from the previous one (frame coordinates). */
  onChange?: (box: Box) => void
  onPen?: (trail: Point[]) => void
}) {
  const [layers, setLayers] = useState(NO_PAGE_LAYERS)
  const shots = useRef<ElementShot[] | null>(null)
  const measure = useRef(onMeasure)
  measure.current = onMeasure
  const observer = useRef<ResizeObserver | null>(null)
  const pen = useRef<PenMark | null>(null)

  useEffect(() => setLayers((current) => offerPage(current, html)), [html])
  useEffect(() => () => observer.current?.disconnect(), [])

  const loaded = (id: number, frame: HTMLIFrameElement) => {
    const doc = frame.contentDocument
    const body = doc?.body
    observer.current?.disconnect()
    observer.current = null
    if (auto && body) {
      // Fonts and images land after load and still grow the page.
      const report = () => {
        if (body.scrollHeight > 0) measure.current(Math.ceil(body.scrollHeight))
      }
      report()
      const Observer = (frame.contentWindow as (Window & typeof globalThis) | null)?.ResizeObserver
      if (Observer) {
        const watch = new Observer(report)
        watch.observe(body)
        observer.current = watch
      }
    }
    if (doc && onPen) {
      const next = penTrail(doc, pen.current)
      if (next) {
        pen.current = next.mark
        onPen(next.trail)
      }
    } else if (doc && onChange) {
      const next = snapshotPage(doc)
      const box = changedRegion(shots.current, next)
      shots.current = next
      if (box) onChange(box)
    }
    setLayers((current) => pageLoaded(current, id))
  }

  return (
    <>
      {[layers.shown, layers.loading].map(
        (layer) =>
          layer && (
            <iframe
              key={layer.id}
              title={title}
              srcDoc={layer.html}
              sandbox="allow-same-origin"
              tabIndex={-1}
              aria-hidden={layer !== layers.shown}
              onLoad={(event) => loaded(layer.id, event.currentTarget)}
              width={width}
              height={height}
              className="pointer-events-none absolute top-0 left-0 block border-0"
              style={{ width, height, visibility: layer === layers.shown ? 'visible' : 'hidden' }}
            />
          ),
      )}
    </>
  )
})
