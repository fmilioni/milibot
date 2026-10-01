import { AVATAR_COLOR_HEX, COST_SYSTEM_ROWS, type CostDay, type CostSummary, firstBot } from '@milibot/shared'
import { useQueryClient } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import { Gauge, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/api/queries'
import { useApiQuery } from '@/api/use-api-query'
import { useAppStore } from '@/features/workspace/store'
import { useApiMutation } from '@/features/workspace/use-api-mutation'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { cn } from '@/lib/cn'
import { formatBytes, formatTokens, formatUsd } from '@/lib/format'
import { shortPath } from '@/lib/platform'
import { Button } from '@/ui/Button'
import { Segmented } from '@/ui/Segmented'
import { Select } from '@/ui/Select'
import { Spinner } from '@/ui/Spinner'
import { Tooltip } from '@/ui/Tooltip'

import { getDebugStorage, getSpendStatus, loadCosts, purgeDebugData, resumeSpend } from './api'
import { costBars } from './cost-chart'
import { Notice, SettingsCard, SettingsPage, SettingsRow } from './SettingsLayout'
import { useWorkspacePreferences } from './store'

type SystemRowName = keyof typeof COST_SYSTEM_ROWS extends `system:${infer Name}` ? Name : never

/** Label of a row for Milibot's own LLM work, in the app language; null for a bot row. */
function systemRowLabel(key: string | null, t: TFunction): string | null {
  if (!key || !(key in COST_SYSTEM_ROWS)) return null
  return t(`settings.costs.systemRows.${key.slice('system:'.length) as SystemRowName}`)
}
const SPEND_STEPS = [1, 2, 5, 10, 20, 50, 100, 200]
const RETENTION_STEPS = [7, 14, 30, 60, 90, 180, 365]

function StatCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <SettingsCard className="min-w-0 gap-0.5 px-3.5 py-3">
      <span className="text-xs text-fg-muted">{label}</span>
      <span className="text-4xl leading-7 font-bold text-fg tabular-nums">{value}</span>
      <span className="truncate text-xs text-fg-secondary">{detail}</span>
    </SettingsCard>
  )
}

function dayLabel(day: string, locale: string, options: Intl.DateTimeFormatOptions): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Intl.DateTimeFormat(locale, options).format(new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1))
}

/** Daily cost, one bar per day (today highlighted), with a tooltip per bar and a table for screen readers. */
function DailyChart({ days }: { days: CostDay[] }) {
  const { t, i18n } = useTranslation()
  const bars = costBars(days)
  const locale = i18n.language
  return (
    <figure className="flex h-full flex-col gap-2">
      <figcaption className="text-sm font-semibold text-fg-secondary">
        {t('settings.costs.daily', { count: days.length })}
      </figcaption>
      <div className="flex h-[128px] items-end gap-[6px] border-b border-border" aria-hidden>
        {bars.map((bar) => (
          <Tooltip
            key={bar.day}
            content={`${dayLabel(bar.day, locale, { weekday: 'short', day: 'numeric', month: 'short' })} · ${formatUsd(
              bar.costUsd,
              locale,
            )} · ${t('settings.costs.tokens', { value: formatTokens(bar.tokens, locale) })}`}
          >
            <div className="group flex h-full min-w-0 flex-1 items-end">
              <div
                className={cn(
                  'w-full rounded-t-[4px] transition-[filter] group-hover:brightness-110',
                  bar.today ? 'bg-accent' : 'bg-accent/35',
                )}
                style={{ height: `${Math.max(bar.heightPct, bar.costUsd > 0 ? 2 : 0.8)}%` }}
              />
            </div>
          </Tooltip>
        ))}
      </div>
      <div className="flex justify-between text-2xs text-fg-muted">
        <span>{days[0] ? dayLabel(days[0].day, locale, { day: 'numeric', month: 'short' }) : ''}</span>
        <span>{t('settings.costs.today')}</span>
      </div>
      <table className="sr-only">
        <caption>{t('settings.costs.daily', { count: days.length })}</caption>
        <tbody>
          {days.map((d) => (
            <tr key={d.day}>
              <th scope="row">{d.day}</th>
              <td>{formatUsd(d.costUsd, locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}

function Breakdown({ byBot, byModel }: { byBot: CostSummary | null; byModel: CostSummary | null }) {
  const { t, i18n } = useTranslation()
  const bots = useAppStore((s) => s.bots)
  const [mode, setMode] = useState<'bot' | 'model'>('bot')
  const summary = mode === 'bot' ? byBot : byModel
  const rows = (summary?.rows ?? []).filter((r) => r.costUsd > 0 || r.tokens > 0).slice(0, 6)
  const max = Math.max(...rows.map((r) => r.costUsd), 0.000001)
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-fg-secondary">{t('settings.costs.breakdown')}</span>
        <Segmented
          label={t('settings.costs.breakdown')}
          value={mode}
          options={[
            { value: 'bot', label: t('settings.costs.byBot') },
            { value: 'model', label: t('settings.costs.byModel') },
          ]}
          onChange={setMode}
        />
      </div>
      {rows.length === 0 ? (
        <p className="py-4 text-center text-sm text-fg-muted">{t('settings.costs.nothingYet')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => {
            const bot = mode === 'bot' && row.key ? bots[row.key] : undefined
            const color = bot ? AVATAR_COLOR_HEX[bot.avatar.color] : 'var(--text-muted)'
            const label = systemRowLabel(row.key, t) ?? row.label ?? row.key ?? t('settings.costs.unknown')
            return (
              <li
                key={row.key ?? 'none'}
                className="grid grid-cols-[minmax(0,110px)_minmax(0,1fr)_64px] items-center gap-2.5"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="size-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
                  <span className="truncate text-sm text-fg" title={label}>
                    {label}
                  </span>
                </span>
                <span className="h-1.5 overflow-hidden rounded-full bg-surface-3" aria-hidden>
                  <span
                    className="block h-full rounded-full"
                    style={{ width: `${(row.costUsd / max) * 100}%`, background: color }}
                  />
                </span>
                <span className="text-right font-mono text-xs text-fg-secondary tabular-nums">
                  {formatUsd(row.costUsd, i18n.language)}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export function CostsSettings() {
  const { t, i18n } = useTranslation()
  const workspaceId = useWorkspaceId()
  const showToast = useAppStore((s) => s.showToast)
  const firstBotName = useAppStore((s) => firstBot(Object.values(s.bots))?.name ?? '')
  const { prefs, loaded, set } = useWorkspacePreferences(workspaceId)
  const queryClient = useQueryClient()
  const costs = useApiQuery(queryKeys.costs(workspaceId), () => loadCosts(workspaceId)).data
  const overview = costs?.overview ?? null
  const storage = useApiQuery(queryKeys.debugStorage(workspaceId), () => getDebugStorage(workspaceId))
  const spend = useApiQuery(queryKeys.spendStatus(workspaceId), () => getSpendStatus(workspaceId))
  const resume = useApiMutation(() => resumeSpend(workspaceId), {
    invalidates: [queryKeys.spendStatus(workspaceId)],
  })
  const purge = useApiMutation(() => purgeDebugData(workspaceId), {
    invalidates: [queryKeys.debugStorage(workspaceId)],
    onSuccess: () => showToast('purged'),
  })
  const locale = i18n.language

  const setPref = (patch: Parameters<typeof set>[0]) =>
    void set(patch).then(() =>
      queryClient.invalidateQueries({ queryKey: queryKeys.spendStatus(workspaceId) }),
    )

  const usdOptions = useMemo(
    () => [
      { value: '', label: t('settings.costs.noLimit') },
      ...SPEND_STEPS.map((usd) => ({
        value: String(usd),
        label: t('settings.costs.perDay', { value: formatUsd(usd, locale) }),
      })),
    ],
    [t, locale],
  )
  const withCurrent = (options: typeof usdOptions, value: number | null) =>
    value !== null && !SPEND_STEPS.includes(value)
      ? [
          ...options,
          { value: String(value), label: t('settings.costs.perDay', { value: formatUsd(value, locale) }) },
        ]
      : options
  const dayOptions = (current: number) =>
    [...new Set([...RETENTION_STEPS, current])]
      .sort((a, b) => a - b)
      .map((d) => ({ value: String(d), label: t('settings.costs.days', { count: d }) }))

  const tokens = (value: number) => t('settings.costs.tokens', { value: formatTokens(value, locale) })

  return (
    <SettingsPage title={t('settings.sections.costs')} subtitle={t('settings.costs.subtitle')}>
      {spend.data?.paused && (
        <Notice
          tone="warning"
          icon={<Gauge size={14} className="text-warning" />}
          action={
            <Button size="sm" onClick={() => void resume.run()}>
              {t('settings.costs.resume')}
            </Button>
          }
        >
          {t('settings.costs.pausedNotice', { value: formatUsd(spend.data.todayUsd, locale) })}
        </Notice>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          label={t('settings.costs.today')}
          value={overview ? formatUsd(overview.today.costUsd, locale) : '—'}
          detail={overview ? tokens(overview.today.tokens) : ''}
        />
        <StatCard
          label={t('settings.costs.last7')}
          value={overview ? formatUsd(overview.last7.costUsd, locale) : '—'}
          detail={overview ? tokens(overview.last7.tokens) : ''}
        />
        <StatCard
          label={t('settings.costs.last30')}
          value={overview ? formatUsd(overview.last30.costUsd, locale) : '—'}
          detail={overview ? tokens(overview.last30.tokens) : ''}
        />
        <StatCard
          label={t('settings.costs.cacheSavings')}
          value={overview ? formatUsd(overview.cacheSavingsUsd, locale) : '—'}
          detail={
            overview ? t('settings.costs.cacheShare', { pct: Math.round(overview.cachedShare * 100) }) : ''
          }
        />
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <SettingsCard className="px-4 py-3.5">
          {overview ? <DailyChart days={overview.days} /> : <div className="h-[170px]" />}
        </SettingsCard>
        <SettingsCard className="px-4 py-3.5">
          <Breakdown byBot={costs?.byBot ?? null} byModel={costs?.byModel ?? null} />
        </SettingsCard>
      </div>

      <SettingsCard title={t('settings.costs.limits')}>
        <SettingsRow
          label={t('settings.costs.warn')}
          hint={t('settings.costs.warnHint', { name: firstBotName })}
        >
          <div className="w-[180px]">
            <Select
              label={t('settings.costs.warn')}
              size="sm"
              tone="surface-2"
              disabled={!loaded}
              value={prefs.spendWarnUsd != null ? String(prefs.spendWarnUsd) : ''}
              options={withCurrent(usdOptions, prefs.spendWarnUsd)}
              onChange={(v) => setPref({ spendWarnUsd: v ? Number(v) : null })}
            />
          </div>
        </SettingsRow>
        <SettingsRow label={t('settings.costs.pause')} hint={t('settings.costs.pauseHint')}>
          <div className="w-[180px]">
            <Select
              label={t('settings.costs.pause')}
              size="sm"
              tone="surface-2"
              disabled={!loaded}
              value={prefs.spendPauseUsd != null ? String(prefs.spendPauseUsd) : ''}
              options={withCurrent(usdOptions, prefs.spendPauseUsd)}
              onChange={(v) => setPref({ spendPauseUsd: v ? Number(v) : null })}
            />
          </div>
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title={t('settings.costs.history')}>
        <SettingsRow label={t('settings.costs.payloads')} hint={t('settings.costs.payloadsHint')}>
          <div className="w-[130px]">
            <Select
              label={t('settings.costs.payloads')}
              size="sm"
              tone="surface-2"
              disabled={!loaded}
              value={String(prefs.payloadRetentionDays)}
              options={dayOptions(prefs.payloadRetentionDays)}
              onChange={(v) => setPref({ payloadRetentionDays: Number(v) })}
            />
          </div>
        </SettingsRow>
        <SettingsRow label={t('settings.costs.screenshots')}>
          <div className="w-[130px]">
            <Select
              label={t('settings.costs.screenshots')}
              size="sm"
              tone="surface-2"
              disabled={!loaded}
              value={String(prefs.screenshotRetentionDays)}
              options={dayOptions(prefs.screenshotRetentionDays)}
              onChange={(v) => setPref({ screenshotRetentionDays: Number(v) })}
            />
          </div>
        </SettingsRow>
        <SettingsRow
          label={t('settings.costs.space')}
          hint={
            storage.data
              ? t('settings.costs.spaceHint', {
                  size: formatBytes(storage.data.totalBytes, locale),
                  path: shortPath(storage.data.path),
                })
              : t('common.loading')
          }
        >
          <Button size="sm" disabled={purge.busy} onClick={() => void purge.run()}>
            {purge.busy ? <Spinner size={12} /> : <Trash2 size={12} />}
            {t('settings.costs.purge')}
          </Button>
        </SettingsRow>
      </SettingsCard>
    </SettingsPage>
  )
}
