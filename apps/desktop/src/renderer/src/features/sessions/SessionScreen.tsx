import type { WorkSessionDetail } from '@milibot/shared'
import { type KeyboardEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/api/queries'
import { useApiQuery } from '@/api/use-api-query'
import { RightPanelContent } from '@/app/RightPanel'
import { Composer } from '@/features/chat/Composer'
import { MessageList } from '@/features/chat/MessageList'
import { useProjectStore } from '@/features/projects/store'
import { clampPanelWidth, readSessionPref, writeSessionPref } from '@/features/sessions/lib/session-view'
import { type SessionScreen as SessionScreenState, useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { ScreenPlaceholder } from '@/ui/AsyncView'
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
  const rightPanel = useAppStore((s) => s.rightPanel)

  const available = () => body.current?.getBoundingClientRect().width ?? window.innerWidth
  const resize = (next: number, persist: boolean) => {
    const clamped = clampPanelWidth(next, available())
    setWidth(clamped)
    if (persist) writeSessionPref('panelWidth', String(clamped))
  }

  useEffect(() => {
    const element = body.current
    if (!element) return
    const observer = new ResizeObserver(() => setWidth((w) => clampPanelWidth(w, available())))
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
    resize(width + (event.key === 'ArrowLeft' ? 32 : -32), true)
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-bg" aria-label={session.title}>
      <SessionHeader session={session} bot={bot} bots={bots} />
      <div ref={body} className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col" aria-label={t('session.conversation')}>
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
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('session.resize')}
          aria-valuenow={width}
          tabIndex={0}
          onPointerDown={onDividerDown}
          onKeyDown={onDividerKey}
          className="focus-ring group relative w-px shrink-0 cursor-col-resize bg-border"
        >
          <span className="absolute inset-y-0 -right-1 -left-1 group-hover:bg-accent/30" />
        </div>
        <aside className="flex min-h-0 shrink-0 flex-col bg-surface" style={{ width }}>
          {rightPanel && rightPanel !== 'debug' ? (
            <RightPanelContent panel={rightPanel} />
          ) : (
            <SessionTabs session={session} />
          )}
        </aside>
      </div>
    </main>
  )
}

/** The session's own side column: plan steps and changed files. */
function SessionTabs({ session }: { session: WorkSessionDetail }) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>(() => (readSessionPref('tab') === 'changes' ? 'changes' : 'plan'))

  const chooseTab = (next: Tab) => {
    setTab(next)
    writeSessionPref('tab', next)
  }

  return (
    <>
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
      {tab === 'plan' ? <PlanPane session={session} /> : <ChangesPane sessionId={session.id} />}
    </>
  )
}
