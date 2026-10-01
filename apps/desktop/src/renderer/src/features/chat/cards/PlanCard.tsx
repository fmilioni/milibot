import type { PlanPayload, WorkSession } from '@milibot/shared'
import { ChevronRight, ClipboardList } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import { PlanDecision } from '@/features/plans/PlanDecision'
import { PlanDialog } from '@/features/plans/PlanDialog'
import { PlanProgress, PlanStatusChip } from '@/features/plans/PlanParts'
import { isSessionFinished, planSession, planShowsSession } from '@/features/sessions/lib/session-view'
import { SessionStatusChip, useLaneLabel } from '@/features/sessions/SessionParts'
import { useSessionStore } from '@/features/sessions/store'
import { toastOnError, useAppStore } from '@/features/workspace/store'
import { cn } from '@/lib/cn'
import { DiffStat } from '@/ui/diff/DiffStat'
import { Markdown } from '@/ui/Markdown'

/**
 * A plan sent for approval: title, summary, status and steps, with the decision while it waits. Approved to
 * run in a work session, it follows that session (maybe another bot's) instead of repeating it in a card.
 */
export function PlanCard({ payload }: { payload: PlanPayload }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const workspaceId = useAppStore((s) => s.workspaceId)
  const followsSession = planShowsSession(payload)
  const session = useSessionStore((s) => (followsSession ? planSession(payload, s.sessions) : null))
  const ensureSession = useSessionStore((s) => s.ensure)

  useEffect(() => {
    if (followsSession && payload.sessionId && workspaceId) ensureSession(workspaceId, payload.sessionId)
  }, [followsSession, payload.sessionId, workspaceId, ensureSession])

  if (payload.removed) {
    return (
      <div className="flex items-center gap-2 rounded-[10px] border border-dashed border-border px-3 py-2.5 text-sm text-fg-muted">
        <ClipboardList size={14} className="shrink-0" aria-hidden />
        <span className="truncate">{t('plans.card.removed', { title: payload.title })}</span>
      </div>
    )
  }

  const dialog = open && <PlanDialog planId={payload.planId} onClose={() => setOpen(false)} />
  if (session)
    return (
      <>
        <PlanSessionCard payload={payload} session={session} onView={() => setOpen(true)} />
        {dialog}
      </>
    )

  const pending = payload.status === 'awaiting_approval'
  const running = payload.status === 'approved' || payload.status === 'executing' || payload.status === 'done'
  const comment = payload.feedback?.trim()
  return (
    <div
      className={cn(
        'flex flex-col gap-2.5 rounded-[10px] border bg-surface-2 p-3.5',
        pending ? 'border-accent/40' : 'border-border',
      )}
    >
      <PlanHeader payload={payload} chip={<PlanStatusChip status={payload.status} />} />
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="focus-ring group flex flex-col gap-1 rounded text-left"
      >
        <PlanTitle title={payload.title} />
        <span className="line-clamp-3 text-sm leading-[17px] text-fg-secondary">{payload.summary}</span>
      </button>
      {running && <PlanProgress {...payload.steps} />}
      {comment && !pending && (
        <p className="text-sm text-fg-secondary">
          {t(payload.status === 'rejected' ? 'plans.card.rejectedWith' : 'plans.card.changesRequested', {
            comment,
          })}
        </p>
      )}
      {pending ? (
        <PlanDecision
          planId={payload.planId}
          execution={payload.execution}
          model={payload.model ?? null}
          onView={() => setOpen(true)}
        />
      ) : (
        !running && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="focus-ring w-fit rounded text-sm text-accent hover:underline"
          >
            {t('plans.card.view')}
          </button>
        )
      )}
      {dialog}
    </div>
  )
}

function PlanHeader({ payload, chip }: { payload: PlanPayload; chip: ReactNode }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2">
      <ClipboardList size={15} className="shrink-0 text-fg-muted" aria-hidden />
      <span className="text-xs font-semibold tracking-[0.04em] text-fg-muted uppercase">
        {payload.revision > 1
          ? t('plans.card.labelRevision', { n: payload.revision })
          : t('plans.card.label')}
      </span>
      <span className="flex-1" />
      {chip}
    </div>
  )
}

function PlanTitle({ title }: { title: string }) {
  return (
    <span className="flex items-center gap-1 text-md font-semibold text-fg">
      {title}
      <ChevronRight
        size={14}
        className="shrink-0 text-fg-muted transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
        aria-hidden
      />
    </span>
  )
}

/** The plan and the session running it, live: who works on it, what it is doing, steps and changes. */
function PlanSessionCard({
  payload,
  session,
  onView,
}: {
  payload: PlanPayload
  session: WorkSession
  onView: () => void
}) {
  const { t } = useTranslation()
  const laneDetail = useSessionStore((s) => s.laneDetail[session.id])
  const bots = useAppStore((s) => s.bots)
  const openWorkSession = useAppStore((s) => s.openWorkSession)
  const finished = isSessionFinished(session.status)
  const doing = useLaneLabel(finished ? undefined : session.lane, laneDetail, bots)
  const worker = bots[session.botId]
  const otherBot = session.botId !== payload.botId
  const steps = session.steps.total > 0 ? session.steps : payload.steps
  const changes = session.changes
  const openSession = () => void toastOnError(openWorkSession(session.id))

  return (
    <div
      className={cn(
        'flex flex-col gap-2.5 rounded-[10px] border bg-surface-2 p-3.5',
        session.status === 'running' ? 'border-accent/40' : 'border-border',
      )}
    >
      <PlanHeader payload={payload} chip={<SessionStatusChip status={session.status} />} />
      <button
        type="button"
        onClick={onView}
        className="focus-ring group flex flex-col gap-1 rounded text-left"
      >
        <PlanTitle title={payload.title} />
        {!finished && (
          <span className="line-clamp-2 text-sm leading-[17px] text-fg-secondary">{payload.summary}</span>
        )}
      </button>
      {worker && (!finished || otherBot) && (
        <div className="flex min-w-0 items-center gap-1.5 text-sm">
          <BotAvatar avatar={worker.avatar} size={18} animated={false} className="shrink-0" />
          <span className="shrink-0 font-semibold text-fg">{worker.name}</span>
          {doing && (
            <>
              <span className="shrink-0 text-fg-muted" aria-hidden>
                ·
              </span>
              <span className="flex min-w-0 items-center gap-1.5 text-accent" aria-live="polite">
                <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />
                <span className="truncate">{doing}</span>
              </span>
            </>
          )}
        </div>
      )}
      {steps.total > 0 && <PlanProgress done={steps.done} total={steps.total} />}
      {finished && session.resultSummary && (
        <div className="line-clamp-4 border-l-2 border-border pl-2.5 text-fg-secondary">
          <Markdown text={session.resultSummary} compact />
        </div>
      )}
      <div className="flex items-center gap-3">
        {changes && changes.files > 0 && (
          <span className="flex items-center gap-1.5 text-sm text-fg-secondary">
            {t('session.changes.files', { count: changes.files })}
            <DiffStat added={changes.additions} removed={changes.deletions} />
          </span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={onView}
          className="focus-ring shrink-0 rounded text-sm text-accent hover:underline"
        >
          {t('plans.card.view')}
        </button>
        <button
          type="button"
          onClick={openSession}
          className="focus-ring shrink-0 rounded-md border border-border px-2.5 py-1 text-sm font-semibold text-fg hover:bg-surface-3"
        >
          {t('chat.session.open')}
        </button>
      </div>
    </div>
  )
}
