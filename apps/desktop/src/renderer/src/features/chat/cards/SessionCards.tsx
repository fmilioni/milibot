import type { SessionBriefPayload, WorkSessionPayload } from '@milibot/shared'
import { ChevronRight, FolderGit2, Rocket } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { PlanProgress } from '@/features/plans/PlanParts'
import { useProjectStore } from '@/features/projects/store'
import { isSessionFinished, sessionResult } from '@/features/sessions/lib/session-view'
import { SessionStatusChip, useLaneLabel } from '@/features/sessions/SessionParts'
import { useSessionStore } from '@/features/sessions/store'
import { useAppStore } from '@/features/workspace/store'
import { cn } from '@/lib/cn'
import { DiffStat } from '@/ui/diff/DiffStat'
import { LinkifiedText } from '@/ui/LinkifiedText'
import { Markdown } from '@/ui/Markdown'
import { StretchedButton } from '@/ui/StretchedButton'

/**
 * A work session in the chat where it started: status (live while it runs), steps, changed files and, once
 * it ends, the bot's summary. Live data comes from `work_session.updated`; the payload is the fallback.
 */
export function WorkSessionCard({ payload, onOpen }: { payload: WorkSessionPayload; onOpen: () => void }) {
  const { t } = useTranslation()
  const live = useSessionStore((s) => s.sessions[payload.sessionId])
  const laneDetail = useSessionStore((s) => s.laneDetail[payload.sessionId])
  const bots = useAppStore((s) => s.bots)
  const status = live?.status ?? payload.status
  const steps = live?.steps ?? payload.steps
  const changes = live?.changes ?? payload.changes
  const summary = sessionResult(live ?? payload, t)
  const finished = isSessionFinished(status)
  const doing = useLaneLabel(finished ? undefined : live?.lane, laneDetail, bots)

  if (payload.removed) {
    return (
      <div className="flex items-center gap-2 rounded-[10px] border border-dashed border-border px-3 py-2.5 text-sm text-fg-muted">
        <Rocket size={13} className="shrink-0" aria-hidden />
        <span className="truncate">{t('chat.session.removedTitle', { title: payload.title })}</span>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'flex flex-col gap-2.5 rounded-[10px] border bg-surface-2 p-3.5',
        status === 'running' ? 'border-accent/40' : 'border-border',
      )}
    >
      <div className="flex items-center gap-2">
        <Rocket size={15} className="shrink-0 text-fg-muted" aria-hidden />
        <span className="text-xs font-semibold tracking-[0.04em] text-fg-muted uppercase">
          {t('chat.session.label')}
        </span>
        <span className="flex-1" />
        <SessionStatusChip status={status} />
      </div>
      <StretchedButton onClick={onOpen} className="flex flex-col gap-1">
        <span className="flex items-center gap-1 text-md font-semibold text-fg">
          <span>
            <LinkifiedText text={payload.title} />
          </span>
          <ChevronRight
            size={14}
            className="shrink-0 text-fg-muted transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
            aria-hidden
          />
        </span>
        {!finished && (
          <span className="line-clamp-2 text-sm leading-[17px] text-fg-secondary">
            <LinkifiedText text={payload.goal} />
          </span>
        )}
      </StretchedButton>
      {doing && (
        <span className="flex items-center gap-1.5 text-sm text-accent" aria-live="polite">
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />
          {doing}
        </span>
      )}
      {steps.total > 0 && <PlanProgress done={steps.done} total={steps.total} />}
      {finished && summary && (
        <div className="line-clamp-4 border-l-2 border-border pl-2.5 text-fg-secondary">
          <Markdown text={summary} compact />
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
          onClick={onOpen}
          className="focus-ring shrink-0 rounded-md border border-border px-2.5 py-1 text-sm font-semibold text-fg hover:bg-surface-3"
        >
          {t('chat.session.open')}
        </button>
      </div>
    </div>
  )
}

/** A plan's session where the plan card already follows it: one line to say it started. */
export function WorkSessionStartedRow({
  payload,
  onOpen,
}: {
  payload: WorkSessionPayload
  onOpen: () => void
}) {
  const { t } = useTranslation()
  const bot = useAppStore((s) => s.bots[payload.botId])
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-[10px] border border-border bg-surface-2 px-3 py-2 text-sm">
      <Rocket size={13} className="shrink-0 text-fg-muted" aria-hidden />
      <span className="shrink-0 text-fg-secondary">
        {bot ? t('chat.session.started', { name: bot.name }) : t('chat.session.startedNoBot')}
      </span>
      <span className="shrink-0 text-fg-muted" aria-hidden>
        ·
      </span>
      <span className="min-w-0 flex-1 truncate font-semibold text-fg">
        <LinkifiedText text={payload.title} />
      </span>
      <button
        type="button"
        onClick={onOpen}
        className="focus-ring shrink-0 rounded text-sm font-medium text-accent hover:underline"
      >
        {t('chat.session.openShort')}
      </button>
    </div>
  )
}

/** First message of a session's conversation: what the bot was asked to do, where, and the plan it follows. */
export function SessionBriefCard({ payload, content }: { payload: SessionBriefPayload; content: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const project = useProjectStore((s) =>
    payload.projectId ? s.projects.find((p) => p.id === payload.projectId) : undefined,
  )
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border bg-surface p-3.5">
      <div className="flex items-center gap-2 text-xs font-semibold tracking-[0.04em] text-fg-muted uppercase">
        <Rocket size={13} className="shrink-0" aria-hidden />
        {t('chat.session.briefLabel')}
      </div>
      <span className="text-md font-semibold text-fg">
        <LinkifiedText text={payload.title} />
      </span>
      <span className="text-base leading-[1.5] whitespace-pre-wrap text-fg-secondary">
        <LinkifiedText text={payload.goal} />
      </span>
      {(project || payload.repoName || payload.cwd) && (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
          {project && <span>{t('chat.session.briefProject', { name: project.name })}</span>}
          {(payload.repoName || payload.cwd) && (
            <span className="flex min-w-0 items-center gap-1 font-mono">
              <FolderGit2 size={12} className="shrink-0" aria-hidden />
              <span className="truncate">{payload.repoName ?? payload.cwd}</span>
            </span>
          )}
        </span>
      )}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="focus-ring w-fit rounded text-sm font-medium text-accent hover:underline"
      >
        {t(open ? 'chat.session.hideBrief' : 'chat.session.showBrief')}
      </button>
      {open && (
        <div className="selectable max-h-80 overflow-y-auto rounded-lg border border-border bg-surface-2 px-3 py-2.5 font-mono text-sm leading-[1.5] break-words whitespace-pre-wrap text-fg-secondary">
          <LinkifiedText text={content} />
        </div>
      )}
    </div>
  )
}
