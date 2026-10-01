import type { Bot, VmStats } from '@milibot/shared'
import { Server } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import { botUsageRows, diskPercent, percentOf, usageTone } from '@/features/vm/lib/vm-stats'
import { useAppStore } from '@/features/workspace/store'
import { cn } from '@/lib/cn'
import { formatBytes, formatGb } from '@/lib/format'
import { TONE_FILL, TONE_TEXT } from '@/lib/tone'

/** Bars of the last minutes (0..1, null = no sample yet); the newest one is solid. */
export function Sparkline({
  values,
  height,
  label,
  className = '',
}: {
  values: Array<number | null>
  height: number
  label: string
  className?: string
}) {
  const last = values.length - 1
  return (
    <div role="img" aria-label={label} className={`flex items-end gap-[2px] ${className}`} style={{ height }}>
      {values.map((value, i) => (
        <span
          key={i}
          className={cn('min-w-0 flex-1 rounded-t-[2px] bg-accent', i !== last && 'opacity-40')}
          style={{ height: value === null ? 0 : Math.max(2, Math.round(value * height)) }}
        />
      ))}
    </div>
  )
}

function UsageTrack({
  percent,
  fill,
  height = 4,
  label,
}: {
  percent: number
  fill: string
  height?: number
  label: string
}) {
  return (
    <span
      className="relative block w-full overflow-hidden rounded-full bg-border"
      style={{ height }}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
    >
      <span
        className={`absolute inset-y-0 left-0 rounded-full ${fill}`}
        style={{ width: `${percent > 0 ? Math.max(2, percent) : 0}%` }}
      />
    </span>
  )
}

/** A bot (avatar + name) or the "System" row. */
function BotUsageLabel({ bot, size, hint = false }: { bot: Bot | undefined; size: number; hint?: boolean }) {
  const { t } = useTranslation()
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      {bot ? (
        <BotAvatar avatar={bot.avatar} size={size} animated={false} className="shrink-0" />
      ) : (
        <span
          className="flex shrink-0 items-center justify-center rounded-full bg-surface-3 text-fg-secondary"
          style={{ width: size, height: size }}
        >
          <Server size={Math.round(size * 0.55)} aria-hidden />
        </span>
      )}
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-fg">{bot?.name ?? t('vmUsage.other')}</span>
        {hint && !bot && <span className="truncate text-xs text-fg-muted">{t('vmUsage.otherHint')}</span>}
      </span>
    </span>
  )
}

/** Used/total of each disk with a bar; `compact` puts name, bar and value on one line (sidebar popover). */
export function DiskUsageList({ stats, compact = false }: { stats: VmStats; compact?: boolean }) {
  const { t, i18n } = useTranslation()
  return (
    <>
      {(['system', 'data'] as const).map((kind) => {
        const disk = stats.disks[kind]
        if (!disk) return null
        const percent = diskPercent(disk)
        const tone = usageTone(percent)
        const name = t(`vmUsage.disks.${kind}`)
        const value = (
          <span
            className={`tabular-nums ${compact ? 'w-16 shrink-0 text-right text-2xs' : ''} ${
              tone === 'success' ? 'text-fg-muted' : `font-semibold ${TONE_TEXT[tone]}`
            }`}
          >
            {t('vmUsage.diskValue', {
              used: formatGb(disk.usedBytes, i18n.language),
              total: formatGb(disk.totalBytes, i18n.language),
            })}
          </span>
        )
        const track = (
          <UsageTrack
            percent={percent}
            {...(compact ? {} : { height: 5 })}
            fill={compact || tone !== 'success' ? TONE_FILL[tone] : 'bg-accent'}
            label={t(kind === 'system' ? 'vmUsage.systemDisk' : 'vmUsage.dataDisk')}
          />
        )
        return compact ? (
          <div key={kind} className="flex items-center gap-2">
            <span className="w-11 shrink-0 truncate text-2xs text-fg-muted">{name}</span>
            {track}
            {value}
          </div>
        ) : (
          <div key={kind} className="flex flex-col gap-1">
            <div className="flex justify-between text-xs">
              <span className="text-fg-secondary">{name}</span>
              {value}
            </div>
            {track}
          </div>
        )
      })}
    </>
  )
}

/** CPU and memory of each bot (and "System"); `compact` shows numbers only (sidebar popover). */
export function BotUsageList({ stats, compact = false }: { stats: VmStats; compact?: boolean }) {
  const { t, i18n } = useTranslation()
  const bots = useAppStore((s) => s.bots)
  return (
    <>
      {botUsageRows(stats, new Set(Object.keys(bots))).map((row) => {
        const bot = row.botId ? bots[row.botId] : undefined
        const cpu = `${Math.round(row.cpuPercent)}%`
        const memory = formatBytes(row.memoryBytes, i18n.language)
        if (compact)
          return (
            <div key={row.botId ?? 'other'} className="flex items-center text-xs">
              <BotUsageLabel bot={bot} size={16} />
              <span className="w-10 text-right font-medium text-fg tabular-nums">{cpu}</span>
              <span className="w-14 text-right font-medium text-fg tabular-nums">{memory}</span>
            </div>
          )
        const fill = row.botId ? 'bg-accent' : 'bg-fg-muted'
        return (
          <div key={row.botId ?? 'other'} className="flex items-center border-t border-border py-2 text-base">
            <BotUsageLabel bot={bot} size={24} hint />
            <span className="flex w-[28%] items-center gap-2.5 pr-4">
              <span className="min-w-0 flex-1">
                <UsageTrack percent={row.cpuPercent} height={5} fill={fill} label={t('vmUsage.cpu')} />
              </span>
              <span className="text-sm font-medium text-fg tabular-nums">{cpu}</span>
            </span>
            <span className="flex w-[28%] items-center gap-2.5 pr-4">
              <span className="min-w-0 flex-1">
                <UsageTrack
                  percent={percentOf(row.memoryBytes, stats.memory.totalBytes)}
                  height={5}
                  fill={fill}
                  label={t('vmUsage.memory')}
                />
              </span>
              <span className="text-sm font-medium text-fg tabular-nums">{memory}</span>
            </span>
          </div>
        )
      })}
    </>
  )
}
