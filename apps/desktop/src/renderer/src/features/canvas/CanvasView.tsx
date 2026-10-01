import type { Bot, DesignDetail, DesignFrame } from '@milibot/shared'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/api/queries'
import { useApiQuery } from '@/api/use-api-query'
import { centerOn, fitAll, frameRects, resolveTheme, withLabel } from '@/features/canvas/lib/canvas'
import { DeleteDesignDialog } from '@/features/designs/DeleteDesignDialog'
import { useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { fitViewport, type Size, type Viewport } from '@/lib/viewport'
import { ScreenPlaceholder } from '@/ui/AsyncView'
import { Menu } from '@/ui/Menu'
import { Popover } from '@/ui/Popover'

import { frameMenuEntries, switcherEntries, themeMenuEntries } from './CanvasMenus'
import { CanvasToolbar } from './CanvasToolbar'
import { DesignExportPanel, useDesignExport } from './ExportPanel'
import { RevisionsDialog } from './RevisionsDialog'
import { SourceDialog } from './SourceDialog'
import { Stage } from './Stage'
import { type Presence, useDesignStore } from './store'
import { useCanvasShortcuts } from './use-canvas-shortcuts'
import { VariablesPanel } from './VariablesPanel'

/** A bot's presence stays on screen this long after its last design event. */
const PRESENCE_LINGER_MS = 4000
const savedViewports = new Map<string, Viewport>()

/** The bot changing the design (latest write), lingering a little after its last event. */
function usePresence(designId: string): Presence | null {
  const byBot = useDesignStore((s) => s.presence[designId])
  const latest = Object.values(byBot ?? {})
    .filter((p): p is Presence => p?.mode === 'write')
    .sort((a, b) => b.at - a.at)[0]
  const [lingerEndedAt, setLingerEndedAt] = useState(() =>
    latest && Date.now() - latest.at >= PRESENCE_LINGER_MS ? latest.at : null,
  )
  useEffect(() => {
    if (!latest || latest.active) return
    const left = latest.at + PRESENCE_LINGER_MS - Date.now()
    const timer = setTimeout(() => setLingerEndedAt(latest.at), Math.max(0, left) + 50)
    return () => clearTimeout(timer)
  }, [latest])
  if (!latest) return null
  return latest.active || lingerEndedAt !== latest.at ? latest : null
}

/** The canvas of a design: toolbar and stage, with its menus, exports and variables. */
export function CanvasView({
  designId,
  conversationId,
  windowMode = false,
  onClose,
  onSwitch,
}: {
  designId: string
  /** The chat next to the canvas ("Ask for a change" writes there); null in the canvas window. */
  conversationId: string | null
  windowMode?: boolean
  onClose: () => void
  onSwitch?: (designId: string) => void
}) {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const bots = useAppStore((s) => s.bots)
  const design = useDesignStore((s) => s.details[designId])
  const load = useDesignStore((s) => s.load)
  const { error, loading } = useApiQuery(queryKeys.design(workspaceId, designId), () =>
    load(workspaceId, designId),
  )

  if (!design) {
    return (
      <ScreenPlaceholder
        failed={Boolean(error) && !loading}
        message={t('canvas.notFound')}
        action={{ label: windowMode ? t('common.close') : t('canvas.back'), onClick: onClose }}
      />
    )
  }
  return (
    <DesignCanvas
      key={design.id}
      workspaceId={workspaceId}
      design={design}
      bots={bots}
      conversationId={conversationId}
      windowMode={windowMode}
      onClose={onClose}
      onSwitch={onSwitch}
    />
  )
}

const toggle = (anchor: DOMRect) => (current: DOMRect | null) => (current ? null : anchor)

function DesignCanvas({
  workspaceId,
  design,
  bots,
  conversationId,
  windowMode,
  onClose,
  onSwitch,
}: {
  workspaceId: string
  design: DesignDetail
  bots: Record<string, Bot>
  conversationId: string | null
  windowMode: boolean
  onClose: () => void
  onSwitch?: (designId: string) => void
}) {
  const { t } = useTranslation()
  const measured = useDesignStore((s) => s.measured)
  const askAboutFrame = useDesignStore((s) => s.askAboutFrame)
  const revisions = useDesignStore((s) => s.revisions[design.id])
  const loadRevisions = useDesignStore((s) => s.loadRevisions)
  const conversationDesigns = useDesignStore((s) =>
    conversationId ? s.byConversation[conversationId] : undefined,
  )
  const designs = useDesignStore((s) => s.designs)
  const loadForConversation = useDesignStore((s) => s.loadForConversation)
  const archiveDesign = useDesignStore((s) => s.archiveDesign)
  const presence = usePresence(design.id)
  const [viewport, setViewportState] = useState<Viewport | null>(() => savedViewports.get(design.id) ?? null)
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [forcedTheme, setForcedTheme] = useState<string | null>(null)
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [variablesOpen, setVariablesOpen] = useState(false)
  const [exportAnchor, setExportAnchor] = useState<DOMRect | null>(null)
  const [themeAnchor, setThemeAnchor] = useState<DOMRect | null>(null)
  const [switcherAnchor, setSwitcherAnchor] = useState<DOMRect | null>(null)
  const [frameMenu, setFrameMenu] = useState<{ frameId: string; x: number; y: number } | null>(null)
  const [sourceFrame, setSourceFrame] = useState<DesignFrame | null>(null)
  const [revisionsFrame, setRevisionsFrame] = useState<DesignFrame | null>(null)
  const [deleting, setDeleting] = useState(false)
  const bot = design.botId ? bots[design.botId] : undefined

  const setViewport = useCallback(
    (next: Viewport) => {
      savedViewports.set(design.id, next)
      setViewportState(next)
    },
    [design.id],
  )
  const onSize = useCallback((next: Size) => setSize(next), [])

  if (!viewport && size.width > 0 && size.height > 0) setViewport(fitAll(design.frames, measured, size))

  useEffect(() => {
    if (conversationId) void loadForConversation(workspaceId, conversationId).catch(() => undefined)
  }, [loadForConversation, workspaceId, conversationId])

  if (selectedId && !design.frames.some((f) => f.id === selectedId)) setSelectedId(null)

  const themeOf = useCallback(
    (frame: DesignFrame) =>
      resolveTheme(design.themes, frame.theme, forcedTheme, overrides[frame.id] ?? null),
    [design.themes, forcedTheme, overrides],
  )
  const exporter = useDesignExport(workspaceId, design, themeOf)
  const selected = design.frames.find((f) => f.id === selectedId) ?? null

  const fit = useCallback(
    () => setViewport(fitAll(design.frames, measured, size)),
    [design.frames, measured, size, setViewport],
  )
  const zoomToFrame = useCallback(
    (frameId: string) => {
      const rect = frameRects(design.frames, measured).find((r) => r.id === frameId)
      if (rect) setViewport(fitViewport(withLabel(rect), size, { padding: 48, maxZoom: 2 }))
    },
    [design.frames, measured, size, setViewport],
  )
  const center = (frameId: string) => {
    const rect = frameRects(design.frames, measured).find((r) => r.id === frameId)
    if (rect && viewport) setViewport(centerOn(viewport, rect, size))
  }

  useCanvasShortcuts({
    viewport,
    size,
    setViewport,
    fit,
    copySelected: selected ? () => void exporter.copy(selected) : null,
    deselect: selectedId && !frameMenu && !exportAnchor && !variablesOpen ? () => setSelectedId(null) : null,
  })

  const menuFrame = frameMenu ? design.frames.find((f) => f.id === frameMenu.frameId) : undefined
  useEffect(() => {
    if (frameMenu) void loadRevisions(workspaceId, design.id)
  }, [frameMenu, loadRevisions, workspaceId, design.id])

  const frameEntries = (frame: DesignFrame) =>
    frameMenuEntries({
      t,
      frame,
      design,
      bot,
      shownTheme: themeOf(frame),
      revisionCount: (revisions?.data ?? []).filter((r) => r.frameId === frame.id).length,
      exporter,
      onAsk: conversationId
        ? () =>
            askAboutFrame(conversationId, {
              designId: design.id,
              frameId: frame.id,
              frameName: frame.name,
              designName: design.name,
            })
        : null,
      onViewHtml: () => setSourceFrame(frame),
      onTheme: (theme) =>
        setOverrides((current) => {
          const next = { ...current }
          if (theme === resolveTheme(design.themes, frame.theme, forcedTheme)) delete next[frame.id]
          else next[frame.id] = theme
          return next
        }),
      onVersions: () => setRevisionsFrame(frame),
      onCenter: () => center(frame.id),
    })

  const switchable = (conversationDesigns ?? []).filter((id) => designs[id])

  return (
    <main className="relative flex min-w-0 flex-1 flex-col bg-surface" aria-label={design.name}>
      <CanvasToolbar
        workspaceId={workspaceId}
        design={design}
        bot={bot}
        windowMode={windowMode}
        canSwitch={switchable.length > 1 && Boolean(onSwitch)}
        forcedTheme={forcedTheme}
        variablesOpen={variablesOpen}
        exportOpen={exportAnchor !== null}
        exporting={exporter.busy}
        onSwitcher={(anchor) => setSwitcherAnchor(toggle(anchor))}
        onThemeMenu={(anchor) => setThemeAnchor(toggle(anchor))}
        onVariables={() => setVariablesOpen(!variablesOpen)}
        onExport={(anchor) => setExportAnchor(toggle(anchor))}
        onArchive={(archived) =>
          void archiveDesign(workspaceId, design.id, archived).catch(() =>
            useAppStore.getState().showToast('error'),
          )
        }
        onDelete={() => setDeleting(true)}
        onClose={onClose}
      />

      <Stage
        workspaceId={workspaceId}
        design={design}
        bots={bots}
        viewport={viewport}
        onViewport={setViewport}
        size={size}
        onSize={onSize}
        forcedTheme={forcedTheme}
        overrides={overrides}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onFrameMenu={(frameId, x, y) => setFrameMenu({ frameId, x, y })}
        onZoomToFrame={zoomToFrame}
        onFit={fit}
        presence={presence}
      />

      {variablesOpen && (
        <div className="absolute top-[58px] right-[90px] z-panel">
          <VariablesPanel
            workspaceId={workspaceId}
            design={design}
            botName={bot?.name ?? '…'}
            onClose={() => setVariablesOpen(false)}
          />
        </div>
      )}
      {exportAnchor && (
        <Popover anchor={exportAnchor} onClose={() => setExportAnchor(null)} menu>
          <DesignExportPanel
            frames={design.frames}
            designName={design.name}
            actions={exporter}
            onDone={() => setExportAnchor(null)}
          />
        </Popover>
      )}
      {themeAnchor && (
        <Menu
          entries={themeMenuEntries(t, design.themes, forcedTheme, (theme) => {
            setForcedTheme(theme)
            setOverrides({})
          })}
          x={themeAnchor.left}
          y={themeAnchor.bottom + 6}
          width={220}
          label={t('canvas.theme.menu')}
          onClose={() => setThemeAnchor(null)}
        />
      )}
      {switcherAnchor && (
        <Menu
          entries={switcherEntries(t, switchable, designs, design.id, onSwitch)}
          x={switcherAnchor.left}
          y={switcherAnchor.bottom + 6}
          width={300}
          label={t('canvas.designsTitle')}
          onClose={() => setSwitcherAnchor(null)}
        />
      )}
      {frameMenu && menuFrame && (
        <Menu
          entries={frameEntries(menuFrame)}
          x={frameMenu.x}
          y={frameMenu.y}
          width={250}
          label={t('canvas.menu.label', { name: menuFrame.name })}
          onClose={() => setFrameMenu(null)}
        />
      )}
      {deleting && (
        <DeleteDesignDialog
          workspaceId={workspaceId}
          designId={design.id}
          name={design.name}
          onClose={() => setDeleting(false)}
          onDeleted={onClose}
        />
      )}
      {sourceFrame && (
        <SourceDialog
          workspaceId={workspaceId}
          designId={design.id}
          frame={sourceFrame}
          onClose={() => setSourceFrame(null)}
        />
      )}
      {revisionsFrame && (
        <RevisionsDialog
          workspaceId={workspaceId}
          designId={design.id}
          frame={revisionsFrame}
          bots={bots}
          onClose={() => setRevisionsFrame(null)}
        />
      )}
    </main>
  )
}
