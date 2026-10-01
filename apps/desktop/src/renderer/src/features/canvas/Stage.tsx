import type { Bot, DesignDetail, DesignFrame } from '@milibot/shared'
import { Move, PenTool } from 'lucide-react'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  draftHeight,
  FRAME_LABEL_HEIGHT,
  frameRects,
  hitTest,
  MIN_RENDER_PX,
  rectToScreen,
  resolveTheme,
  themeBackground,
  themeKey,
  visibleFrameIds,
} from '@/features/canvas/lib/canvas'
import { useReducedMotion } from '@/features/workspace/use-reduced-motion'
import { cn } from '@/lib/cn'
import { type Size, stepZoom, type Viewport, zoomAt } from '@/lib/viewport'
import { ZoomControls } from '@/ui/ZoomControls'

import { BotCursors } from './BotCursor'
import { FramePage } from './FramePage'
import { PenCursors, usePenTrails } from './PenCursors'
import { botColor, DraftLabels, DraftLayer, DragOverlay, FrameLabels, PresencePill } from './StageLayers'
import { type Presence, useDesignStore } from './store'
import { useBotCursors } from './use-bot-cursors'
import { useStageGestures } from './use-stage-gestures'

const IDENTITY: Viewport = { x: 0, y: 0, zoom: 1 }

export interface StageProps {
  workspaceId: string
  design: DesignDetail
  bots: Record<string, Bot>
  viewport: Viewport | null
  onViewport: (viewport: Viewport) => void
  size: Size
  onSize: (size: Size) => void
  forcedTheme: string | null
  overrides: Record<string, string>
  selectedId: string | null
  onSelect: (frameId: string | null) => void
  onFrameMenu: (frameId: string, x: number, y: number) => void
  onZoomToFrame: (frameId: string) => void
  onFit: () => void
  presence: Presence | null
}

/** The canvas surface: frames at their positions, pan/zoom, selection, dragging by the label. */
export function Stage({
  workspaceId,
  design,
  bots,
  viewport,
  onViewport,
  size,
  onSize,
  forcedTheme,
  overrides,
  selectedId,
  onSelect,
  onFrameMenu,
  onZoomToFrame,
  onFit,
  presence,
}: StageProps) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const measured = useDesignStore((s) => s.measured)
  const moveFrame = useDesignStore((s) => s.moveFrame)
  const drafts = useDesignStore((s) => s.drafts[design.id])
  const presences = useDesignStore((s) => s.presence[design.id])
  const reducedMotion = useReducedMotion()
  const [draftHeights, setDraftHeights] = useState<Record<string, number>>({})
  const v = viewport ?? IDENTITY

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(() => onSize({ width: el.clientWidth, height: el.clientHeight }))
    observer.observe(el)
    onSize({ width: el.clientWidth, height: el.clientHeight })
    return () => observer.disconnect()
  }, [onSize])

  const rects = useMemo(() => frameRects(design.frames, measured), [design.frames, measured])
  const { drag, pan, space, dragged, worldAt, stageHandlers, labelHandlers } = useStageGestures({
    ref,
    viewport: v,
    rects,
    onViewport,
    onSelect,
    onMove: (frameId, x, y) => void moveFrame(workspaceId, design.id, frameId, x, y).catch(() => undefined),
  })
  const visible = useMemo(() => visibleFrameIds(rects, v, size), [rects, v, size])
  const draftList = useMemo(() => Object.values(drafts ?? {}), [drafts])
  const replaced = useMemo(
    () => new Set(draftList.flatMap((d) => (d.frameId ? [d.frameId] : []))),
    [draftList],
  )
  const draftRects = useMemo(
    () =>
      draftList.map((d) => ({
        id: d.draftId,
        x: d.x,
        y: d.y,
        width: d.width,
        height: draftHeight(d, draftHeights[d.draftId], rects.find((r) => r.id === d.frameId)?.height),
      })),
    [draftList, draftHeights, rects],
  )
  const visibleDrafts = useMemo(() => visibleFrameIds(draftRects, v, size), [draftRects, v, size])
  const measureDraft = useCallback(
    (draftId: string, height: number) =>
      setDraftHeights((current) =>
        current[draftId] === height ? current : { ...current, [draftId]: height },
      ),
    [],
  )
  const themeKeys = useMemo(() => {
    const keys: Record<string, string> = {}
    for (const theme of design.themes) keys[theme] = themeKey(design, theme)
    return keys
  }, [design])
  const themeOf = (frame: DesignFrame) =>
    resolveTheme(design.themes, frame.theme, forcedTheme, overrides[frame.id] ?? null)
  const colorOf = (botId: string) => botColor(bots, botId)
  const writtenDrafts = useMemo(() => draftList.filter((d) => !d.art), [draftList])
  const cursors = useBotCursors({ bots, presences, drafts: writtenDrafts, draftRects, rects, colorOf })
  const pens = usePenTrails()
  const penEntries = draftList.flatMap((d) =>
    d.art ? [{ draftId: d.draftId, name: bots[d.botId]?.name ?? '…', color: colorOf(d.botId) }] : [],
  )

  const onContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    const hit = hitTest(rects, worldAt(event))
    if (!hit) return
    onSelect(hit)
    onFrameMenu(hit, event.clientX, event.clientY)
  }

  const zoomBy = (direction: 1 | -1) =>
    onViewport(zoomAt(v, stepZoom(v.zoom, direction), { x: size.width / 2, y: size.height / 2 }))

  const presenceBot = presence ? bots[presence.botId] : undefined
  const presenceColor = presence ? colorOf(presence.botId) : 'var(--accent)'
  const presenceRect = presence?.frameId ? rects.find((r) => r.id === presence.frameId) : undefined
  // A frame being written shows its bot as drawing before the write itself starts.
  const drafter = presence ? undefined : draftList[0]
  const pillBot = presenceBot ?? (drafter ? bots[drafter.botId] : undefined)
  const pillColor = drafter ? colorOf(drafter.botId) : presenceColor
  const pillRect =
    presenceRect ?? draftRects.find((r) => drafts?.[r.id]?.botId === (presence?.botId ?? drafter?.botId))
  const selectedRect = selectedId ? rects.find((r) => r.id === selectedId) : undefined
  const cursor = pan ? 'cursor-grabbing' : space ? 'cursor-grab' : 'cursor-default'

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="application"
      aria-label={t('canvas.stageLabel', { name: design.name })}
      aria-roledescription={t('canvas.stageRole')}
      {...stageHandlers}
      onContextMenu={onContextMenu}
      onDoubleClick={(event) => {
        const hit = hitTest(rects, worldAt(event))
        if (hit) onZoomToFrame(hit)
      }}
      className={`relative min-h-0 flex-1 touch-none overflow-hidden bg-surface outline-none select-none ${cursor}`}
    >
      {viewport && (
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{ transform: `translate(${v.x}px, ${v.y}px) scale(${v.zoom})` }}
        >
          {design.frames.map((frame) => {
            const rect = rects.find((r) => r.id === frame.id)
            if (!rect) return null
            const theme = themeOf(frame)
            const background = themeBackground(design, theme)
            const dragging = drag?.moved && drag.frameId === frame.id
            const show =
              visible.has(frame.id) && rect.width * v.zoom >= MIN_RENDER_PX && !replaced.has(frame.id)
            const editing = presence && presenceRect?.id === frame.id
            const scan = cursors.scans.get(frame.id)
            return (
              <div
                key={frame.id}
                className={cn(
                  'absolute shadow-[0_1px_3px_rgba(0,0,0,0.08)]',
                  dragging
                    ? 'opacity-90'
                    : 'transition-[left,top] duration-200 ease-out motion-reduce:transition-none',
                )}
                style={{
                  left: dragging ? drag.x : frame.x,
                  top: dragging ? drag.y : frame.y,
                  width: rect.width,
                  height: rect.height,
                  background: background ?? 'var(--surface-2)',
                }}
              >
                {show && (
                  <FramePage
                    workspaceId={workspaceId}
                    designId={design.id}
                    frame={frame}
                    theme={theme}
                    version={`${frame.updatedAt}:${themeKeys[theme] ?? ''}`}
                    height={rect.height}
                    background={background}
                    watch={cursors.writers.has(frame.id)}
                    onChange={cursors.markFrame}
                  />
                )}
                {scan && (
                  <div
                    className="pointer-events-none absolute inset-0 overflow-hidden"
                    style={{ ['--scan-color' as string]: colorOf(scan.botId) }}
                  >
                    <div key={scan.since} className="canvas-read-scan" />
                  </div>
                )}
                {editing && (
                  <div
                    className="pointer-events-none absolute inset-0 overflow-hidden"
                    style={{ ['--shimmer-color' as string]: `${presenceColor}24` }}
                  >
                    <div className="canvas-shimmer" />
                  </div>
                )}
                {frame.art?.status === 'drawing' && !replaced.has(frame.id) && (
                  <div
                    className="pointer-events-none absolute inset-0 overflow-hidden"
                    style={{
                      outline: `${1.5 / v.zoom}px dashed ${colorOf(frame.art.botId ?? '')}`,
                      ['--shimmer-color' as string]: `${colorOf(frame.art.botId ?? '')}24`,
                    }}
                  >
                    <div className="canvas-shimmer" />
                  </div>
                )}
                {frame.art?.status === 'failed' && (
                  <div
                    className="pointer-events-none absolute inset-0 flex items-center justify-center"
                    style={{ outline: `${1.5 / v.zoom}px dashed var(--color-fg-muted)` }}
                  >
                    {rect.width * v.zoom >= 150 && (
                      <span className="text-fg-muted" style={{ fontSize: 12 / v.zoom }}>
                        {t('canvas.artFailed')}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )
          })}
          <DraftLayer
            design={design}
            drafts={draftList}
            rects={draftRects}
            visible={visibleDrafts}
            zoom={v.zoom}
            colorOf={colorOf}
            onMeasure={measureDraft}
            onChange={cursors.markDraft}
            onPen={pens.push}
          />
        </div>
      )}

      {viewport && (
        <>
          <DraftLabels drafts={draftList} rects={draftRects} viewport={v} size={size} />
          <FrameLabels
            design={design}
            rects={rects}
            viewport={v}
            size={size}
            drag={drag}
            selectedId={selectedId}
            editingId={presence ? presenceRect?.id : undefined}
            editingColor={presenceColor}
            themeOf={themeOf}
            handlers={labelHandlers}
            onZoomToFrame={onZoomToFrame}
            onMenu={(frameId, x, y) => {
              onSelect(frameId)
              onFrameMenu(frameId, x, y)
            }}
          />
        </>
      )}

      {viewport && <BotCursors entries={cursors.entries} viewport={v} reduced={reducedMotion} />}
      {viewport && (
        <PenCursors
          pens={penEntries}
          rects={draftRects}
          trails={pens.trails}
          viewport={v}
          reduced={reducedMotion}
        />
      )}

      {drag?.moved && viewport && (
        <DragOverlay drag={drag} rect={rects.find((r) => r.id === drag.frameId)} viewport={v} />
      )}

      {(presence || drafter) && viewport && (
        <PresencePill
          label={t('canvas.presence', { name: pillBot?.name ?? '…' })}
          color={pillColor}
          position={(() => {
            if (!pillRect) return { left: size.width / 2, top: 16, center: true }
            const screen = rectToScreen(v, pillRect)
            return {
              left: Math.min(Math.max(8, screen.x + screen.width), size.width - 8),
              top: Math.max(8, screen.y - FRAME_LABEL_HEIGHT - 34),
              center: false,
            }
          })()}
        />
      )}

      {selectedRect &&
        !dragged &&
        !drag?.moved &&
        viewport &&
        (() => {
          const screen = rectToScreen(v, selectedRect)
          if (screen.y + screen.height + 44 > size.height) return null
          return (
            <div
              className="pointer-events-none absolute flex items-center gap-[5px] rounded-md bg-fg px-2 py-1 text-xs text-bg"
              style={{ left: Math.max(8, screen.x), top: screen.y + screen.height + 16 }}
            >
              <Move size={11} aria-hidden />
              {t('canvas.dragHint')}
            </div>
          )
        })()}

      {design.frames.length === 0 && draftList.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="flex max-w-[320px] flex-col items-center gap-2 text-center text-base text-fg-muted">
            <PenTool size={18} aria-hidden />
            {t('canvas.empty', { name: bots[design.botId ?? '']?.name ?? '…' })}
          </div>
        </div>
      )}

      <ZoomControls
        className="absolute bottom-4 left-4"
        zoom={v.zoom}
        onStep={zoomBy}
        onActualSize={() => onViewport(zoomAt(v, 1, { x: size.width / 2, y: size.height / 2 }))}
        onFit={onFit}
      />
      {size.width >= 640 && (
        <div className="pointer-events-none absolute right-4 bottom-[21px] text-xs text-fg-muted">
          {t('canvas.navHint')}
        </div>
      )}
    </div>
  )
}
