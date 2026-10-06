import type { DesignFrame } from '@milibot/shared'
import { ImageOff } from 'lucide-react'
import { memo, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { type Box, changedRegion, snapshotPage } from '@/features/canvas/lib/bot-cursor'
import { pageChanged, shownPage } from '@/features/canvas/lib/change-flash'

import { registerFrameIframe } from './frame-iframes'
import { docKey, useDesignStore } from './store'

/** What the canvas follows of its frames' pages (absent in the chat's previews). */
export interface LiveFrame {
  /** The elements that changed since the page shown before (frame pixels). */
  onFlash: (frameId: string, boxes: Box[]) => void
  /** A page finished loading (its iframe is registered for `frameDocument`). */
  onLoad: (frameId: string) => void
}

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
  look,
  height,
  background,
  watch = false,
  onChange,
  live,
}: {
  workspaceId: string
  designId: string
  frame: DesignFrame
  theme: string
  version: string
  /** Key of the theme's values: a page loaded in another look is restyled, not changed. */
  look?: string
  height: number
  background: string | null
  /** A bot is changing this frame: report where each new version differs from the one shown before. */
  watch?: boolean
  onChange?: (frameId: string, box: Box) => void
  /** With `look`: record each page shown, outline what changed and register the iframe. */
  live?: LiveFrame
}) {
  const { t } = useTranslation()
  const doc = useDesignStore((s) => s.docs[docKey(frame.id, theme)])
  const ensureDoc = useDesignStore((s) => s.ensureDoc)
  const setMeasured = useDesignStore((s) => s.setMeasured)
  const iframe = useRef<HTMLIFrameElement | null>(null)
  const frameId = frame.id
  const attach = useCallback(
    (el: HTMLIFrameElement | null) => {
      iframe.current = el
      if (!el || !live) return
      return registerFrameIframe(frameId, el)
    },
    [frameId, live],
  )
  const auto = frame.height === null

  useEffect(() => {
    ensureDoc(workspaceId, designId, frame.id, theme, version)
  }, [ensureDoc, workspaceId, designId, frame.id, theme, version])

  const loaded = () => {
    measure()
    const doc = iframe.current?.contentDocument
    if (!doc?.body) return
    const next = snapshotPage(doc)
    const before = shownPage(frame.id)
    if (live && look !== undefined) {
      const boxes = pageChanged(frame.id, look, next)
      if (boxes.length) live.onFlash(frame.id, boxes)
      live.onLoad(frame.id)
    }
    const box = watch && before ? changedRegion(before, next) : null
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
          ref={attach}
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
