import { type Bot, planProgress } from '@milibot/shared'
import { ChevronUp, ClipboardList, Rocket } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import { PlanStatusChip } from '@/features/plans/PlanParts'
import { usePlanStore } from '@/features/plans/store'
import { type ActiveWork, activeWork } from '@/features/sessions/lib/session-view'
import { SessionStatusChip } from '@/features/sessions/SessionParts'
import { useSessionStore } from '@/features/sessions/store'
import { toastOnError, useAppStore } from '@/features/workspace/store'
import { cn } from '@/lib/cn'
import { Popover } from '@/ui/Popover'
import { Spinner } from '@/ui/Spinner'

/** "N in progress" over the VM line while work sessions or plans run; a click lists them. */
export function ActiveWorkLine() {
  const { t } = useTranslation()
  const workspaceId = useAppStore((s) => s.workspaceId)
  const online = useAppStore((s) => s.connectionState === 'online')
  const sessions = useSessionStore((s) => s.sessions)
  const sessionsWorkspace = useSessionStore((s) => s.workspaceId)
  const plans = usePlanStore((s) => s.running)
  const plansWorkspace = usePlanStore((s) => s.runningWorkspaceId)
  const [button, setButton] = useState<HTMLButtonElement | null>(null)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)

  useEffect(() => {
    if (!workspaceId || !online) return
    void useSessionStore
      .getState()
      .loadOpen(workspaceId)
      .catch(() => undefined)
    void usePlanStore
      .getState()
      .loadRunning(workspaceId)
      .catch(() => undefined)
  }, [workspaceId, online])

  const items = useMemo(
    () =>
      activeWork(
        sessionsWorkspace === workspaceId ? Object.values(sessions) : [],
        plansWorkspace === workspaceId ? plans : [],
      ),
    [sessions, sessionsWorkspace, plans, plansWorkspace, workspaceId],
  )
  const open = anchor !== null && items.length > 0
  if (items.length === 0) return null

  const label = t('footer.activeWork.count', { count: items.length })
  return (
    <>
      <button
        ref={setButton}
        type="button"
        aria-expanded={open}
        aria-label={`${label} — ${t('footer.activeWork.hint')}`}
        onClick={() => setAnchor(open ? null : (button?.getBoundingClientRect() ?? null))}
        className={cn(
          'focus-ring group -my-1 flex items-center gap-2 rounded-md px-1 py-1 hover:bg-surface-3',
          open && 'bg-surface-3',
        )}
      >
        <Spinner size={12} className="text-accent" />
        <span className="min-w-0 flex-1 truncate text-left text-sm leading-4 text-fg-secondary">{label}</span>
        <ChevronUp
          size={12}
          aria-hidden
          className={cn(
            'shrink-0 group-hover:text-fg-secondary',
            open ? 'text-fg-secondary' : 'text-fg-muted',
          )}
        />
      </button>
      {open && (
        <Popover
          anchor={anchor}
          placement="above-start"
          trigger={button}
          label={t('footer.activeWork.title')}
          onClose={() => setAnchor(null)}
        >
          <ActiveWorkPopover items={items} onPick={() => setAnchor(null)} />
        </Popover>
      )}
    </>
  )
}

function ActiveWorkPopover({ items, onPick }: { items: ActiveWork[]; onPick: () => void }) {
  const { t } = useTranslation()
  const bots = useAppStore((s) => s.bots)
  return (
    <div className="flex max-h-[inherit] w-[320px] flex-col gap-2 rounded-xl border border-border bg-surface-2 p-3.5 shadow-[0_8px_24px_rgba(0,0,0,0.14)] dark:shadow-[0_10px_30px_rgba(0,0,0,0.5)]">
      <div className="flex items-center gap-1.5">
        <Spinner size={12} className="text-fg-muted" />
        <span className="shrink-0 text-xs leading-[13px] font-semibold text-fg-secondary">
          {t('footer.activeWork.title')}
        </span>
        <span className="ml-auto text-2xs leading-3 text-fg-muted tabular-nums">{items.length}</span>
      </div>
      <ul className="-mx-1.5 flex min-h-0 flex-col overflow-y-auto">
        {items.map((item) => (
          <li key={`${item.kind}:${item.id}`}>
            <ActiveWorkRow item={item} bots={bots} onPick={onPick} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function ActiveWorkRow({
  item,
  bots,
  onPick,
}: {
  item: ActiveWork
  bots: Record<string, Bot>
  onPick: () => void
}) {
  const { t } = useTranslation()
  const openWorkSession = useAppStore((s) => s.openWorkSession)
  const openConversation = useAppStore((s) => s.openConversation)
  const data = item.kind === 'session' ? item.session : item.plan
  const bot = bots[data.botId]
  const steps = item.kind === 'session' ? item.session.steps : planProgress(item.plan.steps)
  const Icon = item.kind === 'session' ? Rocket : ClipboardList
  const onClick = () => {
    onPick()
    void toastOnError(
      item.kind === 'session' ? openWorkSession(item.session.id) : openConversation(item.plan.conversationId),
    )
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-inset flex w-full flex-col gap-1.5 rounded-lg px-1.5 py-2 text-left hover:bg-surface-3"
    >
      <span className="flex min-w-0 items-center gap-2">
        <Icon size={13} className="shrink-0 text-fg-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{data.title}</span>
        {item.kind === 'session' ? (
          <SessionStatusChip status={item.session.status} />
        ) : (
          <PlanStatusChip status={item.plan.status} />
        )}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 pl-[21px] text-xs text-fg-muted">
        {bot && <BotAvatar avatar={bot.avatar} size={14} animated={false} className="shrink-0" />}
        <span className="min-w-0 truncate">
          {[bot?.name, item.kind === 'plan' ? t('footer.activeWork.inChat') : null]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {steps.total > 0 && (
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <span className="h-1 w-10 overflow-hidden rounded-full bg-border" aria-hidden>
              <span
                className="block h-full rounded-full bg-success"
                style={{ width: `${Math.round((steps.done / steps.total) * 100)}%` }}
              />
            </span>
            <span className="tabular-nums">
              {t('footer.activeWork.steps', { done: steps.done, total: steps.total })}
            </span>
          </span>
        )}
      </span>
    </button>
  )
}
