import type { VmStats } from '@milibot/shared'
import { Activity, Cpu, HardDrive, Info, MemoryStick, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import {
  diskTotals,
  fullestDisk,
  historyBars,
  memoryPercent,
  peakCpu,
  usageTone,
} from '@/features/vm/lib/vm-stats'
import { cn } from '@/lib/cn'
import { formatBytes, formatGb } from '@/lib/format'
import { TONE_TEXT } from '@/lib/tone'
import { Spinner } from '@/ui/Spinner'

import { BotUsageList, DiskUsageList, Sparkline } from './VmUsageParts'

const CHART_HEIGHT = 50

function Column({
  icon,
  label,
  value,
  unit,
  children,
  first = false,
}: {
  icon: ReactNode
  label: string
  value: string
  unit: string
  children: ReactNode
  first?: boolean
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-1 flex-col gap-2.5 px-[18px] py-4',
        !first && 'border-l border-border',
      )}
    >
      <div className="flex items-center gap-1.5 text-sm text-fg-muted">
        {icon}
        {label}
      </div>
      <div className="flex items-end gap-1.5">
        <span className="text-7xl leading-[30px] font-bold tracking-[-0.5px] text-fg tabular-nums">
          {value}
        </span>
        <span className="pb-[5px] text-sm text-fg-muted">{unit}</span>
      </div>
      {children}
    </div>
  )
}

/** Live usage at the top of Settings › Virtual machine: charts, disks and what each bot uses. */
export function VmUsageCard({
  stats,
  onGrow,
}: {
  stats: VmStats | null
  onGrow: (disk: 'system' | 'data') => void
}) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const gb = (bytes: number) => t('common.gb', { value: formatGb(bytes, lang) })

  return (
    <section
      aria-label={t('vmUsage.now')}
      className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface-2"
    >
      <header className="flex items-center justify-between border-b border-border px-[18px] py-3.5">
        <div className="flex items-center gap-2">
          <Activity size={15} className="text-fg-secondary" aria-hidden />
          <h2 className="text-base font-semibold text-fg">{t('vmUsage.now')}</h2>
          {stats && (
            <span className="flex items-center gap-[5px] rounded-md bg-success-soft px-[7px] py-[3px] text-xs font-medium text-success">
              <span className="size-1.5 rounded-full bg-success" />
              {t('vmUsage.live')}
            </span>
          )}
        </div>
        <span className="text-sm text-fg-muted">{t('vmUsage.window')}</span>
      </header>

      {!stats ? (
        <div className="flex items-center gap-2 px-[18px] py-8 text-sm text-fg-muted">
          <Spinner size={13} />
          {t('vmUsage.measuring')}
        </div>
      ) : (
        <>
          <div className="flex">
            <Column
              first
              icon={<Cpu size={13} aria-hidden />}
              label={t('vmUsage.cpu')}
              value={`${Math.round(stats.cpuPercent)}%`}
              unit={t('vmUsage.cores', { count: stats.cpus })}
            >
              <Sparkline
                values={historyBars(stats, 'cpu')}
                height={CHART_HEIGHT}
                label={t('vmUsage.chartLabel', {
                  label: t('vmUsage.cpu'),
                  value: `${Math.round(stats.cpuPercent)}%`,
                })}
              />
              <span className="truncate text-xs text-fg-muted">
                {t('vmUsage.cpuFoot', {
                  peak: Math.round(peakCpu(stats)),
                  load: new Intl.NumberFormat(lang, { maximumFractionDigits: 2 }).format(
                    stats.loadavg[0] ?? 0,
                  ),
                })}
              </span>
            </Column>
            <Column
              icon={<MemoryStick size={13} aria-hidden />}
              label={t('vmUsage.memory')}
              value={gb(stats.memory.usedBytes)}
              unit={t('vmUsage.memoryOf', {
                size: gb(stats.memory.totalBytes),
                percent: Math.round(memoryPercent(stats)),
              })}
            >
              <Sparkline
                values={historyBars(stats, 'memory')}
                height={CHART_HEIGHT}
                label={t('vmUsage.chartLabel', {
                  label: t('vmUsage.memory'),
                  value: gb(stats.memory.usedBytes),
                })}
              />
              <span className="truncate text-xs text-fg-muted">
                {t('vmUsage.cacheFoot', { size: formatBytes(stats.memory.cacheBytes, lang) })}
              </span>
            </Column>
            <Column
              icon={<HardDrive size={13} aria-hidden />}
              label={t('vmUsage.disk')}
              value={gb(diskTotals(stats).usedBytes)}
              unit={t('vmUsage.ofTotal', { size: gb(diskTotals(stats).totalBytes) })}
            >
              <div className="flex flex-col justify-center gap-2" style={{ height: CHART_HEIGHT }}>
                <DiskUsageList stats={stats} />
              </div>
              <DiskFoot stats={stats} onGrow={onGrow} />
            </Column>
          </div>

          <div className="flex flex-col border-t border-border px-[18px] pt-3.5 pb-2">
            <div className="flex items-center pb-2">
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className="shrink-0 text-sm font-semibold text-fg">{t('vmUsage.perBot')}</span>
                <span className="truncate text-sm text-fg-muted">{t('vmUsage.perBotHint')}</span>
              </span>
              <span className="w-[28%] text-xs text-fg-muted">{t('vmUsage.cpu')}</span>
              <span className="w-[28%] text-xs text-fg-muted">{t('vmUsage.memory')}</span>
            </div>
            <BotUsageList stats={stats} />
            <div className="flex items-center gap-1.5 border-t border-border pt-2 pb-1.5 text-xs text-fg-muted">
              <Info size={12} className="shrink-0" aria-hidden />
              {t('vmUsage.barsNote', { cores: stats.cpus, memory: gb(stats.memory.totalBytes) })}
            </div>
          </div>
        </>
      )}
    </section>
  )
}

function DiskFoot({ stats, onGrow }: { stats: VmStats; onGrow: (disk: 'system' | 'data') => void }) {
  const { t } = useTranslation()
  const full = fullestDisk(stats)
  if (!full) return null
  const tone = usageTone(full.percent)
  return (
    <span className={`flex items-center gap-[5px] text-xs ${TONE_TEXT[tone]}`}>
      <TriangleAlert size={12} className="shrink-0" aria-hidden />
      {t('vmUsage.diskFull', { disk: t(`vmUsage.disks.${full.disk}`), percent: Math.round(full.percent) })}
      <span aria-hidden>·</span>
      <button
        type="button"
        onClick={() => onGrow(full.disk)}
        className="focus-ring rounded font-semibold text-accent hover:underline"
      >
        {t('vmUsage.grow')}
      </button>
    </span>
  )
}
