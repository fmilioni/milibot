import type { WorkSessionDetail } from '@milibot/shared'
import { X } from 'lucide-react'
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/api/queries'
import { useApiQuery } from '@/api/use-api-query'
import { RightPanelContent } from '@/app/RightPanel'
import { Composer } from '@/features/chat/Composer'
import { MessageList } from '@/features/chat/MessageList'
import { useProjectStore } from '@/features/projects/store'
import {
  clampPanelWidth,
  overlayPanelWidth,
  readSessionPref,
  sessionPanelCollapsed,
  writeSessionPref,
} from '@/features/sessions/lib/session-view'
import { type SessionScreen as SessionScreenState, useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { cn } from '@/lib/cn'
import { ScreenPlaceholder } from '@/ui/AsyncView'
import { handleDialogKeys } from '@/ui/dialog-keys'
import { IconButton } from '@/ui/IconButton'
import { Segmented } from '@/ui/Segmented'

import { ChangesPane } from './ChangesPane'
import { PlanPane } from './PlanPane'
import { SessionHeader } from './SessionHeader'
import { useSessionStore } from './store'

type Tab = 'plan' | 'changes'
const DEFAULT_PANEL_WIDTH = 520

/** A work session full window: its conversation on the left, steps and changed files on the right. */
export function SessionScreen() {
  const { t } = useTranslation()
  const screen = useAppStore((s) => s.screen) as SessionScreenState
  const workspaceId = useWorkspaceId()
  const closeWorkSession = useAppStore((s) => s.closeWorkSession)
  const detail = useSessionStore((s) => s.details[screen.sessionId])
  const loadDetail = useSessionStore((s) => s.loadDetail)
  const watch = useSessionStore((s) => s.watch)
  const loadProjects = useProjectStore((s) => s.load)

  useEffect(() => {
    watch(screen.sessionId)
    return () => watch(null)
  }, [watch, screen.sessionId])

  const { error, loading } = useApiQuery(queryKeys.session(workspaceId, screen.sessionId), () =>
    loadDetail(workspaceId, screen.sessionId),
  )

  useEffect(() => {
    if (useProjectStore.getState().workspaceId !== workspaceId)
      void loadProjects(workspaceId).catch(() => undefined)
  }, [loadProjects, workspaceId])

  if (!detail) {
    return (
      <ScreenPlaceholder
        failed={Boolean(error) && !loading}
        message={t('session.notFound')}
        action={{ label: t('session.backToChat'), onClick: closeWorkSession }}
      />
    )
  }
  return <SessionView session={detail} />
}

function SessionView({ session }: { session: WorkSessionDetail }) {
  const { t } = useTranslation()
  const bots = useAppStore((s) => s.bots)
  const bot = bots[session.botId]
  const laneDetail = useSessionStore((s) => s.laneDetail[session.id])
  const lane = session.lane
  const sessionLane = useMemo(() => ({ status: lane.status, detail: laneDetail }), [lane.status, laneDetail])
  const composerSession = useMemo(() => ({ id: session.id, lane }), [session.id, lane])
  const body = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(() => Number(readSessionPref('panelWidth')) || DEFAULT_PANEL_WIDTH)
  // Measured by the observer (null until then); the panel's width never feeds it, so dragging can't collapse.
  const [available, setAvailable] = useState<number | null>(null)
  const rightPanel = useAppStore((s) => s.rightPanel)
  const openedPanel = rightPanel && rightPanel !== 'debug' ? rightPanel : null
  const collapsed = sessionPanelCollapsed(available, openedPanel !== null)
  const shownWidth = available === null ? width : clampPanelWidth(width, available)
  // The session the collapsed panel is open over: another session, or the room coming back, closes it.
  const [overlayFor, setOverlayFor] = useState<string | null>(null)
  if (overlayFor !== null && (!collapsed || overlayFor !== session.id)) setOverlayFor(null)
  const overlayOpen = overlayFor === session.id
  const overlayId = useId()
  const main = useRef<HTMLElement>(null)
  const panelToggle = useRef<HTMLButtonElement>(null)

  const closeOverlay = () => {
    setOverlayFor(null)
    panelToggle.current?.focus()
  }

  const resize = (next: number, persist: boolean) => {
    const clamped = clampPanelWidth(next, body.current?.getBoundingClientRect().width ?? window.innerWidth)
    setWidth(clamped)
    if (persist) writeSessionPref('panelWidth', String(clamped))
  }

  useEffect(() => {
    const element = body.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setAvailable(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const onDividerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const right = body.current?.getBoundingClientRect().right ?? window.innerWidth
    const move = (e: globalThis.PointerEvent) => resize(right - e.clientX, false)
    const up = (e: globalThis.PointerEvent) => {
      resize(right - e.clientX, true)
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  }

  const onDividerKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    resize(shownWidth + (event.key === 'ArrowLeft' ? 32 : -32), true)
  }

  return (
    <main ref={main} className="relative flex min-w-0 flex-1 flex-col bg-bg" aria-label={session.title}>
      <SessionHeader
        session={session}
        bot={bot}
        bots={bots}
        panelToggle={
          collapsed
            ? {
                open: overlayOpen,
                controls: overlayId,
                onToggle: () => (overlayOpen ? closeOverlay() : setOverlayFor(session.id)),
              }
            : undefined
        }
        panelToggleRef={panelToggle}
      />
      <div ref={body} className="flex min-h-0 flex-1">
        <section
          className={cn('flex flex-1 flex-col', openedPanel ? 'min-w-[320px]' : 'min-w-0')}
          aria-label={t('session.conversation')}
        >
          <MessageList
            conversationId={session.conversationId}
            bots={bots}
            emptyName={bot?.name ?? session.title}
            emptyBot={bot ?? null}
            showRoleChips={false}
            sessionLane={sessionLane}
          />
          <Composer
            conversationId={session.conversationId}
            targetName={bot?.name ?? session.title}
            members={bot ? [bot] : []}
            session={composerSession}
          />
        </section>
        {!collapsed && (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t('session.resize')}
              aria-valuenow={shownWidth}
              tabIndex={0}
              onPointerDown={onDividerDown}
              onKeyDown={onDividerKey}
              className="focus-ring group relative w-px shrink-0 cursor-col-resize bg-border"
            >
              <span className="absolute inset-y-0 -right-1 -left-1 group-hover:bg-accent/30" />
            </div>
            <aside
              className={cn('flex min-h-0 flex-col bg-surface', openedPanel ? 'min-w-0' : 'shrink-0')}
              style={{ width: shownWidth }}
            >
              {openedPanel ? <RightPanelContent panel={openedPanel} /> : <SessionTabs session={session} />}
            </aside>
          </>
        )}
      </div>
      {overlayOpen && available !== null && (
        <SessionPanelOverlay
          id={overlayId}
          main={main}
          width={overlayPanelWidth(available)}
          onClose={closeOverlay}
        >
          <SessionTabs
            session={session}
            trailing={
              <>
                <kbd className="rounded border border-border px-1 font-sans text-2xs leading-4 text-fg-secondary">
                  Esc
                </kbd>
                <IconButton
                  label={t('session.panelClose')}
                  onClick={closeOverlay}
                  className="focus-ring hit-44"
                >
                  <X size={16} />
                </IconButton>
              </>
            }
          />
        </SessionPanelOverlay>
      )}
    </main>
  )
}

/**
 * The collapsed plan/changes panel opened over the conversation, below the header: `width` null takes the
 * whole column. A modal dialog: focus starts on the selected tab and stays inside; Escape or a click
 * outside it (the header excepted, its buttons act on their own) closes it.
 */
function SessionPanelOverlay({
  id,
  main,
  width,
  onClose,
  children,
}: {
  id: string
  main: RefObject<HTMLElement | null>
  width: number | null
  onClose: () => void
  children: ReactNode
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const close = useEffectEvent(onClose)

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    const scope = main.current?.closest('#root') ?? document.body
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node) || !scope.contains(target) || ref.current?.contains(target)) return
      if (main.current?.querySelector(':scope > header')?.contains(target)) return
      // A click on the dimmed conversation would move the focus to the page, away from the toggle.
      if (main.current?.contains(target)) event.preventDefault()
      close()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [main])

  return (
    <>
      {width !== null && (
        <div
          className="scrim-fade-in absolute inset-x-0 top-16 bottom-0 z-panel bg-scrim-panel"
          aria-hidden
        />
      )}
      <div
        ref={ref}
        id={id}
        role="dialog"
        aria-modal
        aria-label={t('session.panel')}
        onKeyDown={(event) => handleDialogKeys(event, ref.current, onClose)}
        className={cn(
          'panel-slide-in absolute top-16 right-0 bottom-0 z-panel flex min-h-0 flex-col bg-surface',
          width === null
            ? 'left-0'
            : 'border-l border-border shadow-[-16px_0_32px_-12px_rgba(13,14,17,0.35)]',
        )}
        style={width === null ? undefined : { width }}
      >
        {children}
      </div>
    </>
  )
}

/** The session's own side column: plan steps and changed files. */
function SessionTabs({ session, trailing }: { session: WorkSessionDetail; trailing?: ReactNode }) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>(() => (readSessionPref('tab') === 'changes' ? 'changes' : 'plan'))

  const chooseTab = (next: Tab) => {
    setTab(next)
    writeSessionPref('tab', next)
  }

  const tabs = (
    <Segmented
      value={tab}
      onChange={chooseTab}
      label={t('session.panel')}
      variant="underline"
      role="tab"
      className="shrink-0 px-5"
      options={[
        {
          value: 'plan',
          label: t('session.tabs.plan'),
          ...(session.steps.total > 0 ? { count: `${session.steps.done}/${session.steps.total}` } : {}),
        },
        {
          value: 'changes',
          label: t('session.tabs.changes'),
          ...(session.changes && session.changes.files > 0
            ? {
                count: (
                  <span className="rounded-full bg-surface-3 px-1.5 text-fg-secondary">
                    {session.changes.files}
                  </span>
                ),
              }
            : {}),
        },
      ]}
    />
  )

  return (
    <>
      {trailing ? (
        <div className="relative shrink-0">
          {tabs}
          <div className="absolute inset-y-0 right-3 flex items-center gap-3">{trailing}</div>
        </div>
      ) : (
        tabs
      )}
      {tab === 'plan' ? <PlanPane session={session} /> : <ChangesPane sessionId={session.id} />}
    </>
  )
}
