import type { DesignFrame } from '@milibot/shared'
import { ImageOff } from 'lucide-react'
import { memo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { type Box, changedRegion, type ElementShot, snapshotPage } from '@/features/canvas/lib/bot-cursor'

import { docKey, useDesignStore } from './store'

/**
 * A frame's compiled page at its native size, in a sandboxed iframe (no scripts; the page's CSP forbids any
 * request). `allow-same-origin` only lets the canvas read the content height of `auto` frames. The iframe
 * never takes pointer events: the canvas handles selection and dragging above it.
 */
export const FramePage = memo(function FramePage({
  workspaceId,
  designId,
  frame,
  theme,
  version,
  height,
  background,
  watch = false,
  onChange,
}: {
  workspaceId: string
  designId: string
  frame: DesignFrame
  theme: string
  version: string
  height: number
  background: string | null
  /** A bot is changing this frame: report where each new version differs from the one shown before. */
  watch?: boolean
  onChange?: (frameId: string, box: Box) => void
}) {
  const { t } = useTranslation()
  const doc = useDesignStore((s) => s.docs[docKey(frame.id, theme)])
  const ensureDoc = useDesignStore((s) => s.ensureDoc)
  const setMeasured = useDesignStore((s) => s.setMeasured)
  const iframe = useRef<HTMLIFrameElement>(null)
  const auto = frame.height === null
  const shots = useRef<ElementShot[] | null>(null)

  useEffect(() => {
    const doc = iframe.current?.contentDocument
    shots.current = watch && doc?.body ? snapshotPage(doc) : null
  }, [watch])

  useEffect(() => {
    ensureDoc(workspaceId, designId, frame.id, theme, version)
  }, [ensureDoc, workspaceId, designId, frame.id, theme, version])

  const loaded = () => {
    measure()
    const doc = iframe.current?.contentDocument
    if (!watch || !doc) return
    const next = snapshotPage(doc)
    const box = shots.current && changedRegion(shots.current, next)
    shots.current = next
    if (box) onChange?.(frame.id, box)
  }

  const measure = () => {
    if (!auto) return
    const body = iframe.current?.contentDocument?.body
    if (!body) return
    const measured = Math.ceil(body.scrollHeight)
    if (measured > 0) setMeasured(frame.id, measured)
  }

  const html = doc?.html ?? null
  return (
    <div
      className="absolute inset-0 overflow-hidden"
      style={{ background: background ?? 'var(--surface-2)' }}
      aria-busy={!html}
    >
      {html ? (
        <iframe
          ref={iframe}
          title={frame.name}
          srcDoc={html}
          sandbox="allow-same-origin"
          tabIndex={-1}
          onLoad={loaded}
          width={frame.width}
          height={height}
          className="pointer-events-none block border-0"
          style={{ width: frame.width, height }}
        />
      ) : doc?.error ? (
        <div
          className="flex size-full flex-col items-center justify-center gap-[0.5em] text-fg-muted"
          style={{ fontSize: Math.max(12, frame.width / 40) }}
        >
          <ImageOff size="2em" aria-hidden />
          <span>{t('canvas.frameFailed')}</span>
        </div>
      ) : (
        <div className="canvas-skeleton size-full" aria-label={t('canvas.loadingFrame')} />
      )}
    </div>
  )
})
