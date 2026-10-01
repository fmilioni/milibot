import type { CliUsage } from '@milibot/shared'
import { Gauge } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  isLimited,
  paceStatus,
  planLabel,
  type UsageBar,
  usageBars,
  type UsageTone,
  usageTooltipText,
} from '@/features/providers/lib/cli-usage'
import { useAppStore } from '@/features/workspace/store'
import { useNow } from '@/hooks/use-now'
import { cliTextParams } from '@/lib/cli-engines'
import { cn } from '@/lib/cn'
import { formatClock } from '@/lib/format'
import { MetaText } from '@/ui/MetaText'
import { Tooltip } from '@/ui/Tooltip'

const FILL: Record<UsageTone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
}

const TEXT: Record<UsageTone, string> = {
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
}

function UsageColumn({ bar }: { bar: UsageBar }) {
  const { t, i18n } = useTranslation()
  const label = t(`footer.quota.windows.${bar.id}`, { defaultValue: bar.label })
  const used = Math.round(bar.utilization * 100)
  const tip = usageTooltipText(bar, t, i18n.language)
  const status = paceStatus(bar)
  return (
    <Tooltip
      content={
        <div className="flex flex-col gap-0.5">
          <span className="font-semibold">{tip.title}</span>
          <span className="text-fg-secondary">
            <MetaText parts={tip.details} />
          </span>
          {tip.renews && <span className="text-fg-secondary">{tip.renews}</span>}
        </div>
      }
    >
      <div className="flex min-w-0 flex-1 flex-col gap-[5px]">
        <div className="flex items-end justify-between gap-2">
          <span className="truncate text-2xs leading-3 text-fg-muted">{label}</span>
          <span
            className={cn(
              'text-md leading-[17px] font-bold tabular-nums',
              bar.tone === 'success' ? 'text-fg' : TEXT[bar.tone],
            )}
          >
            {used}%
          </span>
        </div>
        <span
          className="relative h-1 w-full rounded-[3px] bg-border"
          role="meter"
          aria-label={[tip.title, ...tip.details, tip.renews].filter(Boolean).join(', ')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={used}
        >
          <span
            className={`absolute inset-y-0 left-0 rounded-[3px] ${FILL[bar.tone]}`}
            style={{ width: `${Math.max(used, used > 0 ? 3 : 0)}%` }}
          />
          {bar.pace !== null && (
            <span
              className="absolute -top-[3px] h-2.5 w-[1.5px] bg-fg"
              style={{ left: `${Math.min(99, bar.pace * 100)}%` }}
            />
          )}
        </span>
        {status && (
          <span className={`truncate text-2xs leading-3 ${TEXT[bar.tone]}`}>
            {status.kind === 'on_pace'
              ? t('footer.quota.onPace')
              : t('footer.quota.abovePace', { points: status.points })}
          </span>
        )}
      </div>
    </Tooltip>
  )
}

/** One CLI provider's subscription quota: 5-hour and weekly windows with the even-pace marker. */
function UsageCard({ usage, now }: { usage: CliUsage; now: number }) {
  const { t, i18n } = useTranslation()
  const bars = usageBars(usage, now)
  if (bars.length === 0) return null
  const limited = isLimited(usage)
  const plan = planLabel(usage.plan)
  const params = cliTextParams(usage.engine)
  return (
    <section
      aria-label={t('footer.quota.title', params)}
      className="flex flex-col gap-2 rounded-[10px] border border-border bg-surface-2 px-3 py-2.5"
    >
      <div className="flex items-center gap-1.5">
        <Gauge size={12} className="shrink-0 text-fg-muted" aria-hidden />
        <span className="truncate text-xs leading-[13px] font-semibold text-fg-secondary">
          {t('footer.quota.title', params)}
        </span>
        {plan && (
          <Tooltip content={t('footer.quota.planTooltip', params)}>
            <span className="ml-auto shrink-0 text-2xs leading-3 font-semibold text-accent">{plan}</span>
          </Tooltip>
        )}
      </div>
      <div className="flex gap-3">
        {bars.map((bar) => (
          <UsageColumn key={bar.id} bar={bar} />
        ))}
      </div>
      {limited && (
        <span className="text-2xs leading-3 text-danger">
          <MetaText
            text={
              usage.resetsAt
                ? t('footer.quota.limited', { time: formatClock(usage.resetsAt, i18n.language) })
                : t('footer.quota.limitedNoTime')
            }
          />
        </span>
      )}
    </section>
  )
}

/** Subscription quota cards of the CLI providers that reported one, newest first. */
export function UsageCards() {
  const all = useAppStore((s) => s.cliUsage)
  const now = useNow(60_000)
  const usages = Object.values(all).sort((a, b) => b.updatedAt - a.updatedAt)
  if (!usages.length) return null
  return (
    <>
      {usages.map((usage) => (
        <UsageCard key={usage.providerId} usage={usage} now={now} />
      ))}
    </>
  )
}
