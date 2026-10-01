import type { VmStats } from '@milibot/shared'
import { ArrowRight, Monitor } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { diskTotals, formatUptime, historyBars } from '@/features/vm/lib/vm-stats'
import { formatGb } from '@/lib/format'
import { Spinner } from '@/ui/Spinner'

import { BotUsageList, DiskUsageList, Sparkline } from './VmUsageParts'

function ChartRow({
  label,
  value,
  sub,
  values,
}: {
  label: string
  value: string
  sub: string
  values: Array<number | null>
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-end gap-1.5">
        <span className="min-w-0 flex-1 truncate text-xs text-fg-secondary">{label}</span>
        <span className="text-md leading-[17px] font-bold text-fg tabular-nums">{value}</span>
        <span className="text-2xs leading-3 text-fg-muted">{sub}</span>
      </div>
      <Sparkline
        values={values}
        height={28}
        label={t('vmUsage.chartLabel', { label, value })}
        className="border-b border-border"
      />
    </div>
  )
}

/** Everything about the VM's usage at a glance: charts, disks and bots (sidebar footer popover). */
export function VmUsagePopover({ stats, onAdjust }: { stats: VmStats | null; onAdjust: () => void }) {
  const { t, i18n } = useTranslation()
  const pct = (value: number) => `${Math.round(value)}%`
  const gb = (bytes: number) => t('common.gb', { value: formatGb(bytes, i18n.language) })

  return (
    <div className="flex w-[300px] flex-col gap-3 rounded-xl border border-border bg-surface-2 p-3.5 shadow-[0_8px_24px_rgba(0,0,0,0.14)] dark:shadow-[0_10px_30px_rgba(0,0,0,0.5)]">
      <div className="flex items-center gap-1.5">
        <Monitor size={12} className="shrink-0 text-fg-muted" aria-hidden />
        <span className="shrink-0 text-xs leading-[13px] font-semibold text-fg-secondary">
          {t('vmUsage.title')}
        </span>
        <span className="ml-auto min-w-0 truncate text-2xs leading-3 text-fg-muted">
          {stats
            ? `${t('vmUsage.windowShort')} · ${formatUptime(stats.uptimeSec * 1000, t)}`
            : t('vmUsage.windowShort')}
        </span>
      </div>

      {!stats ? (
        <div className="flex items-center gap-2 py-6 text-sm text-fg-muted">
          <Spinner size={13} />
          {t('vmUsage.measuring')}
        </div>
      ) : (
        <>
          <ChartRow
            label={t('vmUsage.cpu')}
            value={pct(stats.cpuPercent)}
            sub={t('vmUsage.cores', { count: stats.cpus })}
            values={historyBars(stats, 'cpu')}
          />
          <ChartRow
            label={t('vmUsage.memory')}
            value={gb(stats.memory.usedBytes)}
            sub={t('vmUsage.ofTotal', { size: gb(stats.memory.totalBytes) })}
            values={historyBars(stats, 'memory')}
          />

          <div className="flex flex-col gap-1.5">
            <div className="flex items-end gap-1.5">
              <span className="min-w-0 flex-1 truncate text-xs text-fg-secondary">{t('vmUsage.disk')}</span>
              <span className="text-md leading-[17px] font-bold text-fg tabular-nums">
                {gb(diskTotals(stats).usedBytes)}
              </span>
              <span className="text-2xs leading-3 text-fg-muted">
                {t('vmUsage.ofTotal', { size: gb(diskTotals(stats).totalBytes) })}
              </span>
            </div>
            <DiskUsageList stats={stats} compact />
          </div>

          <div className="flex flex-col gap-1.5 border-t border-border pt-2.5">
            <div className="flex text-2xs text-fg-muted">
              <span className="flex-1">{t('vmUsage.perBot')}</span>
              <span className="w-10 text-right">{t('vmUsage.cpuShort')}</span>
              <span className="w-14 text-right">{t('vmUsage.memory')}</span>
            </div>
            <BotUsageList stats={stats} compact />
          </div>
        </>
      )}

      <button
        type="button"
        onClick={onAdjust}
        className="focus-ring flex items-center gap-1 self-end rounded text-xs font-semibold text-accent hover:underline"
      >
        {t('vmUsage.adjust')}
        <ArrowRight size={11} aria-hidden />
      </button>
    </div>
  )
}
