import {
  AVATAR_COLOR_HEX,
  type Bot,
  type DesignDetail,
  type DesignFrame,
  type DesignRect,
  type PlacedFrame,
} from '@milibot/shared'
import { PenTool, SwatchBook } from 'lucide-react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'

import type { Box, Point } from '@/features/canvas/lib/bot-cursor'
import {
  draftGrows,
  FRAME_LABEL_HEIGHT,
  isOffscreen,
  MIN_RENDER_PX,
  rectToScreen,
  themeBackground,
} from '@/features/canvas/lib/canvas'
import type { FrameDraft } from '@/features/canvas/lib/design-drafts'
import { cn } from '@/lib/cn'
import { type Size, type Viewport } from '@/lib/viewport'

import { DraftPage } from './DraftPage'
import type { FrameDrag } from './use-stage-gestures'

/** Frames being written, in world coordinates: the partial page inside a dashed outline in the bot's color. */
export function DraftLayer({
  design,
  drafts,
  rects,
  visible,
  zoom,
  colorOf,
  onMeasure,
  onChange,
  onPen,
}: {
  design: DesignDetail
  drafts: FrameDraft[]
  rects: PlacedFrame[]
  visible: Set<string>
  zoom: number
  colorOf: (botId: string) => string
  onMeasure: (draftId: string, height: number) => void
  onChange: (draftId: string, box: Box) => void
  onPen: (draftId: string, trail: Point[]) => void
}) {
  return drafts.map((draft) => {
    const rect = rects.find((r) => r.id === draft.draftId)
    if (!rect) return null
    const color = colorOf(draft.botId)
    const background = themeBackground(design, draft.theme)
    return (
      <div
        key={draft.draftId}
        className="pointer-events-none absolute"
        style={{
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
          background: background ?? 'var(--surface-2)',
          outline: `${1.5 / zoom}px dashed ${color}`,
        }}
      >
        <div className="absolute inset-0 overflow-hidden">
          {visible.has(draft.draftId) && rect.width * zoom >= MIN_RENDER_PX && (
            <DraftPage
              html={draft.html}
              title={draft.name}
              width={rect.width}
              height={rect.height}
              auto={draftGrows(draft)}
              onMeasure={(height) => onMeasure(draft.draftId, height)}
              {...(draft.art
                ? { onPen: (trail: Point[]) => onPen(draft.draftId, trail) }
                : { onChange: (box: Box) => onChange(draft.draftId, box) })}
            />
          )}
          <div
            className="absolute inset-0 overflow-hidden"
            style={{ ['--shimmer-color' as string]: `${color}24` }}
          >
            <div className="canvas-shimmer" />
          </div>
        </div>
      </div>
    )
  })
}

/** Name labels of new frames being written (a draft that replaces a frame keeps the frame's label). */
export function DraftLabels({
  drafts,
  rects,
  viewport,
  size,
}: {
  drafts: FrameDraft[]
  rects: PlacedFrame[]
  viewport: Viewport
  size: Size
}) {
  const { t } = useTranslation()
  return drafts
    .filter((draft) => !draft.frameId)
    .map((draft) => {
      const rect = rects.find((r) => r.id === draft.draftId)
      if (!rect) return null
      const screen = rectToScreen(viewport, rect)
      if (isOffscreen(screen, size)) return null
      return (
        <div
          key={draft.draftId}
          role="img"
          aria-label={t('canvas.draftLabel', { name: draft.name })}
          className="pointer-events-none absolute flex h-[14px] items-center gap-1.5 overflow-hidden"
          style={{
            left: screen.x,
            top: screen.y - FRAME_LABEL_HEIGHT,
            maxWidth: Math.max(48, screen.width),
          }}
        >
          <span className="truncate text-xs leading-[13px] font-medium text-fg">{draft.name}</span>
          {screen.width >= 150 && (
            <span className="shrink-0 text-xs leading-[13px] text-fg-muted">{t('canvas.drafting')}</span>
          )}
        </div>
      )
    })
}

interface LabelHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void
}

/**
 * Frame names above the frames (drag handles; double click zooms, right click opens the menu) and the
 * outline of the selected frame or the one a bot is editing.
 */
export function FrameLabels({
  design,
  rects,
  viewport,
  size,
  drag,
  selectedId,
  editingId,
  editingColor,
  themeOf,
  handlers,
  onZoomToFrame,
  onMenu,
}: {
  design: DesignDetail
  rects: PlacedFrame[]
  viewport: Viewport
  size: Size
  drag: FrameDrag | null
  selectedId: string | null
  editingId: string | undefined
  editingColor: string
  themeOf: (frame: DesignFrame) => string
  handlers: (frame: DesignFrame) => LabelHandlers
  onZoomToFrame: (frameId: string) => void
  onMenu: (frameId: string, x: number, y: number) => void
}) {
  const { t } = useTranslation()
  return design.frames.map((frame) => {
    const rect = rects.find((r) => r.id === frame.id)
    if (!rect) return null
    const dragging = drag?.moved && drag.frameId === frame.id
    const screen = rectToScreen(viewport, dragging ? { ...rect, x: drag.x, y: drag.y } : rect)
    if (isOffscreen(screen, size)) return null
    const selected = frame.id === selectedId
    const editing = editingId === frame.id
    const wide = screen.width >= 150
    return (
      <div key={frame.id}>
        <button
          type="button"
          aria-label={t('canvas.frameLabel', { name: frame.name })}
          aria-pressed={selected}
          {...handlers(frame)}
          onDoubleClick={(event) => {
            event.stopPropagation()
            onZoomToFrame(frame.id)
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onMenu(frame.id, event.clientX, event.clientY)
          }}
          className={cn(
            'absolute flex h-[14px] items-center gap-1.5 overflow-hidden text-left',
            dragging ? 'cursor-grabbing' : 'cursor-grab',
          )}
          style={{
            left: screen.x,
            top: screen.y - FRAME_LABEL_HEIGHT,
            maxWidth: Math.max(48, screen.width),
          }}
        >
          <span
            className={cn(
              'truncate text-xs leading-[13px]',
              selected
                ? 'font-semibold text-accent'
                : editing
                  ? 'font-medium text-fg'
                  : 'font-medium text-fg-secondary',
            )}
          >
            {frame.name}
          </span>
          {wide && (
            <span className="shrink-0 text-xs leading-[13px] text-fg-muted tabular-nums">
              {frame.width}×{frame.height ?? t('canvas.auto')}
            </span>
          )}
          {frame.art && frame.art.status !== 'ready' && (
            <span className="shrink-0 text-xs leading-[13px] text-fg-muted">
              {t(frame.art.status === 'drawing' ? 'canvas.artDrawing' : 'canvas.artFailed')}
            </span>
          )}
          {wide && design.themes.length > 1 && !frame.art && (
            <span className="flex h-[14px] shrink-0 items-center gap-[3px] rounded-[5px] bg-surface-3 px-1.5 text-2xs leading-3 text-fg-secondary">
              <SwatchBook size={9} aria-hidden />
              {themeOf(frame)}
            </span>
          )}
        </button>
        {(selected || editing) && (
          <div
            className="pointer-events-none absolute"
            style={{
              left: screen.x - 1,
              top: screen.y - 1,
              width: screen.width + 2,
              height: screen.height + 2,
              boxShadow: `0 0 0 1.5px ${selected ? 'var(--accent)' : editingColor}`,
            }}
          />
        )}
      </div>
    )
  })
}

/** While a frame is dragged: the snap guides and, when the daemon will push it, where it will land. */
export function DragOverlay({
  drag,
  rect,
  viewport,
}: {
  drag: FrameDrag
  rect: DesignRect | undefined
  viewport: Viewport
}) {
  const { t } = useTranslation()
  const ghost =
    rect && drag.spot.pushed ? rectToScreen(viewport, { ...rect, x: drag.spot.x, y: drag.spot.y }) : null
  return (
    <>
      {drag.guides.x.map((x) => (
        <div
          key={`gx${x}`}
          className="pointer-events-none absolute top-0 bottom-0 w-px bg-accent/60"
          style={{ left: x * viewport.zoom + viewport.x }}
        />
      ))}
      {drag.guides.y.map((y) => (
        <div
          key={`gy${y}`}
          className="pointer-events-none absolute right-0 left-0 h-px bg-accent/60"
          style={{ top: y * viewport.zoom + viewport.y }}
        />
      ))}
      {ghost && (
        <div
          className="pointer-events-none absolute rounded-[2px] border-[1.5px] border-dashed border-accent bg-accent-soft"
          style={{ left: ghost.x, top: ghost.y, width: ghost.width, height: ghost.height }}
        >
          <span className="absolute top-2 left-2 rounded-md bg-accent px-2 py-0.5 text-xs font-semibold text-on-accent">
            {t('canvas.dropHere')}
          </span>
        </div>
      )}
    </>
  )
}

export function botColor(bots: Record<string, Bot>, botId: string): string {
  const bot = bots[botId]
  return bot ? AVATAR_COLOR_HEX[bot.avatar.color] : 'var(--accent)'
}

export function PresencePill({
  label,
  color,
  position,
}: {
  label: string
  color: string
  position: { left: number; top: number; center: boolean }
}) {
  return (
    <div
      role="status"
      className="pointer-events-none absolute flex h-6 items-center gap-1.5 rounded-xl pr-2.5 pl-1 text-xs font-semibold whitespace-nowrap text-white shadow-[0_2px_8px_rgba(0,0,0,0.12)]"
      style={{
        left: position.left,
        top: position.top,
        background: color,
        transform: position.center ? 'translateX(-50%)' : 'translateX(-100%)',
      }}
    >
      <span className="flex size-4 items-center justify-center rounded-full bg-white/20">
        <PenTool size={9} aria-hidden />
      </span>
      {label}
    </div>
  )
}
