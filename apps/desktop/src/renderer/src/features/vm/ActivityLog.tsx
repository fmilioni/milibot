import type { Bot, BotActivityAction } from '@milibot/shared'
import type { TFunction } from 'i18next'
import { ChevronRight } from 'lucide-react'
import { createElement, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { isMonoKind, stepIcon, stepText } from '@/features/chat/lib/activity-steps'
import { useAppStore } from '@/features/workspace/store'
import { markFromActivity } from '@/lib/click-mark'
import { cn } from '@/lib/cn'
import { formatClock, formatDuration } from '@/lib/format'
import { SectionTitle } from '@/ui/SectionTitle'
import { Tooltip } from '@/ui/Tooltip'

import { Screenshot } from './Screenshot'

/** "Activity" of the VM panel: the bot's recent actions, humanized; a row expands to its full detail. */
export function ActivityLog({ bot }: { bot: Bot }) {
  const { t, i18n } = useTranslation()
  const actions = useAppStore((s) => s.activity[bot.id])
  const loadActivity = useAppStore((s) => s.loadActivity)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    void loadActivity(bot.id)
  }, [bot.id, loadActivity])

  // Newest first; live actions land on top (the scroll container keeps its anchor when scrolled down).
  const recent = useMemo(
    () => [...(actions ?? [])].sort((a, b) => b.time - a.time || (a.id < b.id ? 1 : -1)),
    [actions],
  )

  return (
    <section
      className="flex flex-col gap-1.5 border-t border-border pt-3"
      aria-label={t('panels.vm.activity')}
    >
      <SectionTitle as="h3">{t('panels.vm.activity')}</SectionTitle>
      {recent.length === 0 ? (
        <span className="font-mono text-xs text-fg-muted">{t('panels.vm.noActivity')}</span>
      ) : (
        <ol className="flex flex-col gap-0.5 font-mono text-xs leading-[15px]">
          {recent.map((action) => (
            <ActivityRow
              key={action.id}
              action={action}
              time={formatClock(action.time, i18n.language, { seconds: true })}
              open={expanded.has(action.id)}
              onToggle={() =>
                setExpanded((current) => {
                  const next = new Set(current)
                  if (!next.delete(action.id)) next.add(action.id)
                  return next
                })
              }
            />
          ))}
        </ol>
      )}
    </section>
  )
}

/** Text of a log row: commands and paths keep a short prefix ("terminal: uname -r"). */
function rowText(action: BotActivityAction, t: TFunction, full: boolean): string {
  const detail = full ? (action.fullDetail ?? action.detail) : action.detail
  const text = stepText(action, t, detail)
  if (!isMonoKind(action.kind)) return text || action.tool
  return `${t(`panels.vm.logKinds.${action.kind}`, { defaultValue: action.kind })}: ${text}`
}

function ActivityRow({
  action,
  time,
  open,
  onToggle,
}: {
  action: BotActivityAction
  time: string
  open: boolean
  onToggle: () => void
}) {
  const { t, i18n } = useTranslation()
  const summary = rowText(action, t, false)
  const full = rowText(action, t, true)
  const tone = action.status === 'error' ? 'text-danger' : 'text-fg-secondary'
  return (
    <li className="flex flex-col">
      <Tooltip content={open ? null : (action.error ?? (full !== summary ? full : null))} maxWidth={360}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="focus-ring flex w-full cursor-pointer items-center gap-2 rounded px-1 py-[3px] text-left hover:bg-surface-3/60"
        >
          <span className="shrink-0 text-fg-muted">{time}</span>
          {createElement(stepIcon(action.kind), {
            size: 12,
            className: `shrink-0 ${action.status === 'error' ? 'text-danger' : 'text-accent'}`,
          })}
          <span className={`min-w-0 flex-1 truncate ${tone}`}>{summary}</span>
          <span className="shrink-0 text-fg-muted">
            {action.status === 'running'
              ? '…'
              : action.durationMs !== null && formatDuration(action.durationMs, i18n.language)}
          </span>
          <ChevronRight
            size={11}
            className={cn(
              'shrink-0 text-fg-muted transition-transform motion-reduce:transition-none',
              open && 'rotate-90',
            )}
          />
        </button>
      </Tooltip>
      {open && (
        <div className="selectable ml-[70px] flex flex-col gap-2 pt-1 pr-1 pb-2">
          {(full !== summary || !action.screenshotSha) && (
            <p className={`break-words whitespace-pre-wrap ${tone}`}>{full}</p>
          )}
          {action.error && <p className="break-words whitespace-pre-wrap text-danger">{action.error}</p>}
          {action.screenshotSha && (
            <Screenshot
              sha={action.screenshotSha}
              mark={markFromActivity(action.kind, action.fullDetail ?? action.detail)}
              className="w-56"
            />
          )}
        </div>
      )}
    </li>
  )
}
