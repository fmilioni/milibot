import type { ActivityPayload, ActivityStep, EditedFile } from '@milibot/shared'
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Ellipsis,
  FileMinus,
  FilePen,
  FilePlus,
  LoaderCircle,
  MessageSquareText,
  Square,
  X,
} from 'lucide-react'
import { createElement, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { openDesignFor } from '@/features/canvas/store'
import { splitActivity } from '@/features/chat/lib/activity-split'
import {
  failedFileStep,
  isMonoKind,
  stepDesignName,
  stepIcon,
  stepText,
  stepWatchTarget,
} from '@/features/chat/lib/activity-steps'
import { shortFilePath, splitPath } from '@/features/sessions/lib/session-view'
import { toastOnError, useAppStore } from '@/features/workspace/store'
import { cn } from '@/lib/cn'
import type { MentionTarget } from '@/lib/mentions'
import { DiffStat } from '@/ui/diff/DiffStat'
import { Markdown } from '@/ui/Markdown'
import { Tooltip } from '@/ui/Tooltip'

import { StepFileDiff } from './StepFileDiff'

/** What the bot wrote between tool calls: collapsed to two lines, the whole text on click. */
function NoteRow({ step }: { step: ActivityStep }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <li className="flex items-start gap-2 text-sm">
      <MessageSquareText
        size={13}
        className="mt-px shrink-0 text-fg-muted"
        aria-label={t('chat.activity.note')}
      />
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={cn(
          'focus-ring min-w-0 flex-1 rounded text-left whitespace-pre-wrap text-fg-muted italic',
          !open && 'line-clamp-2',
        )}
      >
        {step.detail}
      </button>
    </li>
  )
}

/** A step with a result (a helper's report): the result shows below it on click. */
function ResultRow({ step }: { step: ActivityStep }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <li className="text-sm">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="focus-ring flex min-h-4 w-full items-center gap-2 rounded text-left"
      >
        {createElement(stepIcon(step.kind), {
          size: 13,
          className: 'shrink-0 text-fg-muted',
          'aria-hidden': true,
        })}
        <span
          className={cn(
            'min-w-0 flex-1 truncate',
            step.status === 'error' ? 'text-danger' : 'text-fg-secondary',
          )}
        >
          {stepText(step, t) || step.tool}
        </span>
        <Chevron size={13} className="shrink-0 text-fg-muted" aria-label={t('chat.activity.showResult')} />
      </button>
      {open && (
        <p className="mt-1 ml-[21px] max-h-60 overflow-y-auto whitespace-pre-wrap text-fg-muted">
          {step.result}
        </p>
      )}
    </li>
  )
}

const FILE_ICONS: Record<EditedFile['status'], typeof FilePen> = {
  added: FilePlus,
  modified: FilePen,
  deleted: FileMinus,
  renamed: FilePen,
}

/** A step that changed files: one line per file ("Edited a.ts +3 −1"), each unfolding its diff below it. */
function FileEditRows({ step, files }: { step: ActivityStep; files: EditedFile[] }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (path: string) => {
    setOpen((current) => {
      const next = new Set(current)
      if (!next.delete(path)) next.add(path)
      return next
    })
  }
  return files.map((file) => {
    const Icon = FILE_ICONS[file.status]
    const Chevron = open.has(file.path) ? ChevronDown : ChevronRight
    const { name, dir } = splitPath(shortFilePath(file.path))
    return (
      <li key={file.path} className="text-sm">
        <button
          type="button"
          onClick={() => toggle(file.path)}
          aria-expanded={open.has(file.path)}
          title={file.path}
          className="focus-ring group flex min-h-4 w-full items-center gap-2 rounded text-left"
        >
          <Icon size={13} className="shrink-0 text-fg-muted" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-fg-secondary">
            {t(`chat.activity.files.${file.status}`)}{' '}
            <span className="font-mono text-fg group-hover:underline">{name}</span>
            {dir && <span className="ml-1.5 font-mono text-fg-muted">{dir}</span>}
          </span>
          <DiffStat added={file.additions} removed={file.deletions} />
          <Chevron
            size={13}
            className="shrink-0 text-fg-muted"
            aria-label={t('chat.activity.files.showDiff')}
          />
        </button>
        {open.has(file.path) && <StepFileDiff toolCallId={step.toolCallId} path={file.path} />}
      </li>
    )
  })
}

/** "Could not edit derivative.ts src/core": a failed file step, named like a successful one. */
function FailedFileText({
  step,
  kind,
}: {
  step: ActivityStep
  kind: NonNullable<ReturnType<typeof failedFileStep>>
}) {
  const { t } = useTranslation()
  const { name, dir } = splitPath(shortFilePath(step.detail))
  return (
    <span className="min-w-0 flex-1 truncate text-danger">
      {t(`chat.activity.files.failed.${kind}`)} <span className="font-mono">{name}</span>
      {dir && <span className="ml-1.5 font-mono text-fg-muted">{dir}</span>}
    </span>
  )
}

function StepRow({ step, onOpenDesign }: { step: ActivityStep; onOpenDesign?: (name: string) => void }) {
  const { t } = useTranslation()
  if (step.kind === 'note') return <NoteRow step={step} />
  if (step.files?.length && step.status === 'ok') return <FileEditRows step={step} files={step.files} />
  if (step.result && step.status !== 'running') return <ResultRow step={step} />
  const text = stepText(step, t)
  const failedFile = failedFileStep(step)
  const design = onOpenDesign ? stepDesignName(step) : null
  const label = failedFile ? (
    <FailedFileText step={step} kind={failedFile} />
  ) : (
    <span
      className={cn(
        'min-w-0 flex-1 truncate',
        isMonoKind(step.kind) && 'font-mono',
        step.status === 'running' ? 'text-fg' : step.status === 'error' ? 'text-danger' : 'text-fg-secondary',
        design && 'group-hover:underline',
      )}
    >
      {text || step.tool}
    </span>
  )
  return (
    <Tooltip content={step.error ?? (design ? t('chat.activity.openDesign') : null)}>
      <li className="flex min-h-4 items-center gap-2 text-sm">
        {createElement(stepIcon(step.kind), {
          size: 13,
          className: 'shrink-0 text-fg-muted',
          'aria-hidden': true,
        })}
        {design && onOpenDesign ? (
          <button
            type="button"
            onClick={() => onOpenDesign(design)}
            className="focus-ring group flex min-w-0 flex-1 rounded text-left"
          >
            {label}
          </button>
        ) : (
          label
        )}
        {step.status === 'ok' && (
          <Check size={13} className="shrink-0 text-success" aria-label={t('chat.activity.ok')} />
        )}
        {step.status === 'running' && (
          <Ellipsis size={13} className="shrink-0 text-fg-muted" aria-label={t('chat.activity.running')} />
        )}
        {step.status === 'error' && (
          <X size={13} className="shrink-0 text-danger" aria-label={t('chat.activity.error')} />
        )}
        {step.status === 'cancelled' && (
          <Square size={11} className="shrink-0 text-fg-muted" aria-label={t('chat.activity.cancelled')} />
        )}
      </li>
    </Tooltip>
  )
}

function ActivityCard({
  payload,
  watch,
  onOpenDesign,
}: {
  payload: Pick<ActivityPayload, 'status' | 'steps'>
  /** "See screen"/"See design" while a step that can be watched is running. */
  watch?: { label: string; onClick: () => void } | undefined
  onOpenDesign?: ((name: string) => void) | undefined
}) {
  const { t } = useTranslation()
  const running = payload.status === 'running'
  const [open, setOpen] = useState<boolean | null>(null)
  const expanded = open ?? running
  const count = payload.steps.filter((s) => s.kind !== 'note').length
  const title =
    payload.status === 'running'
      ? t('chat.activity.working', { count })
      : payload.status === 'error'
        ? t('chat.activity.failed', { count })
        : payload.status === 'cancelled'
          ? t('chat.activity.stopped', { count })
          : t('chat.activity.done', { count })
  const StatusIcon = running
    ? LoaderCircle
    : payload.status === 'done'
      ? Check
      : payload.status === 'error'
        ? CircleAlert
        : Square
  const tone =
    running || payload.status === 'done'
      ? 'text-success'
      : payload.status === 'error'
        ? 'text-danger'
        : 'text-fg-muted'
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border bg-surface px-3 py-2.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen(!expanded)}
          aria-expanded={expanded}
          className="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded text-left"
        >
          <StatusIcon
            size={14}
            className={cn('shrink-0', tone, running && 'animate-spin motion-reduce:animate-none')}
          />
          <span className="truncate text-sm font-semibold text-fg-secondary">{title}</span>
          <span className="flex-1" />
          <ChevronDown
            size={14}
            className={cn('shrink-0 text-fg-muted transition-transform', !expanded && '-rotate-90')}
          />
        </button>
        {watch && (
          <button
            type="button"
            onClick={watch.onClick}
            className="focus-ring shrink-0 rounded text-sm text-accent hover:underline"
          >
            {watch.label}
          </button>
        )}
      </div>
      {expanded && payload.steps.length > 0 && (
        <ul className="flex flex-col gap-2">
          {payload.steps.map((step) => (
            <StepRow key={step.toolCallId} step={step} onOpenDesign={onOpenDesign} />
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * A turn's activity as the bot's notes (plain messages) between cards of steps. The last card links to
 * what its running step can be watched on: the bot's screen, or the design it is drawing.
 */
export function ActivityTurn({
  payload,
  botId,
  conversationId,
  mentions,
  compact,
}: {
  payload: ActivityPayload
  botId: string | null
  conversationId: string
  mentions: MentionTarget[]
  compact: boolean
}) {
  const { t } = useTranslation()
  const showBotScreen = useAppStore((s) => s.showBotScreen)
  const segments = splitActivity(payload)
  const openDesign = (name: string | null) => void toastOnError(openDesignFor(conversationId, botId, name))
  const current = payload.steps.findLast((s) => s.status === 'running')
  const target = payload.status === 'running' && current ? stepWatchTarget(current.kind) : null
  const watch =
    target === 'design'
      ? {
          label: t('chat.activity.showDesign'),
          onClick: () => openDesign(current ? stepDesignName(current) : null),
        }
      : target === 'screen' && botId
        ? { label: t('chat.activity.showScreen'), onClick: () => showBotScreen(botId) }
        : undefined
  const lastSteps = segments.findLast((s) => s.type === 'steps')
  return (
    <div className="flex flex-col gap-2">
      {segments.map((segment) =>
        segment.type === 'note' ? (
          <Markdown key={segment.key} text={segment.text} mentions={mentions} compact={compact} />
        ) : (
          <ActivityCard
            key={segment.key}
            payload={segment}
            watch={segment === lastSteps ? watch : undefined}
            onOpenDesign={(name) => openDesign(name)}
          />
        ),
      )}
    </div>
  )
}
