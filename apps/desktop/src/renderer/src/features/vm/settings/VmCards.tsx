import type { VmDetails, VmDiskKind, VmStatsDisk } from '@milibot/shared'
import { Database, HardDrive, Plus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { formatUptime, percentOf } from '@/features/vm/lib/vm-stats'
import { useNow } from '@/hooks/use-now'
import { cn } from '@/lib/cn'
import { formatGb } from '@/lib/format'
import { type Tone, TONE_SOFT } from '@/lib/tone'
import { Button } from '@/ui/Button'

export function StateBadge({ details }: { details: VmDetails }) {
  const { t } = useTranslation()
  const now = useNow(60_000)
  const state = details.vm.state
  const running = state === 'running'
  const parts = [t(`settings.vm.state.${state}`)]
  if (running && details.workingBots > 0) parts.push(t('settings.vm.working', { count: details.workingBots }))
  if (running && details.startedAt) parts.push(formatUptime(now - details.startedAt, t))
  const tone: Tone = running
    ? 'success'
    : state === 'error'
      ? 'danger'
      : state === 'starting' || state === 'stopping'
        ? 'warning'
        : 'neutral'
  return (
    <span
      className={`inline-flex h-[26px] items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium ${TONE_SOFT[tone]}`}
    >
      <span
        className={cn(
          'size-1.5 rounded-full bg-current',
          state === 'starting' && 'animate-pulse motion-reduce:animate-none',
        )}
      />
      {parts.join(' · ')}
    </span>
  )
}

export function ResourceCard({
  title,
  value,
  unit,
  min,
  max,
  hint,
  changed,
  onCommit,
}: {
  title: string
  value: number
  unit?: string
  min: number
  max: number
  hint: string
  changed: boolean
  onCommit: (value: number) => void
}) {
  const [draft, setDraft] = useState(value)
  const [synced, setSynced] = useState(value)
  if (value !== synced) {
    setSynced(value)
    setDraft(value)
  }
  const pct = max > min ? ((Math.min(draft, max) - min) / (max - min)) * 100 : 100
  const commit = () => {
    if (draft !== value) onCommit(draft)
  }
  return (
    <section
      className={cn(
        'flex flex-col gap-3 rounded-xl border bg-surface-2 px-4 py-3.5',
        changed ? 'border-warning' : 'border-border',
      )}
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold text-fg">{title}</h2>
        <span className="text-3xl font-bold text-fg tabular-nums">
          {draft}
          {unit && <span className="ml-1 text-md">{unit}</span>}
        </span>
      </div>
      <input
        type="range"
        aria-label={title}
        min={min}
        max={Math.max(max, draft)}
        step={1}
        value={draft}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        className="vm-slider h-1.5 w-full cursor-pointer appearance-none rounded-full"
        style={{
          background: `linear-gradient(to right, var(--accent) ${pct}%, var(--surface-3) ${pct}%)`,
        }}
      />
      <span className="text-xs text-fg-muted">{hint}</span>
    </section>
  )
}

export function DiskCard({
  disk,
  usage,
  inGuest,
  onGrow,
}: {
  disk: VmDiskKind
  usage: VmDetails['disks']['system']
  /** Space used inside the running VM; without it, the size of the disk file on the host. */
  inGuest: VmStatsDisk | null
  onGrow: () => void
}) {
  const { t, i18n } = useTranslation()
  const Icon = disk === 'system' ? HardDrive : Database
  const used = inGuest?.usedBytes ?? usage?.actualBytes ?? null
  const pct = inGuest
    ? percentOf(inGuest.usedBytes, inGuest.totalBytes)
    : usage && used !== null
      ? Math.min(100, (used / usage.virtualBytes) * 100)
      : 0
  return (
    <section className="flex flex-col gap-2.5 rounded-xl border border-border bg-surface-2 px-4 py-3.5">
      <div className="flex items-start gap-2.5">
        <Icon size={15} className="mt-0.5 shrink-0 text-fg-secondary" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="text-base font-semibold text-fg">{t(`settings.vm.disks.${disk}.title`)}</h2>
          <span className="truncate text-xs text-fg-muted">{t(`settings.vm.disks.${disk}.subtitle`)}</span>
        </div>
        <Button size="sm" disabled={!usage} onClick={onGrow}>
          <Plus size={12} />
          {t('settings.vm.grow')}
        </Button>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-surface-3"
        role="meter"
        aria-label={t(`settings.vm.disks.${disk}.title`)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-between text-sm">
        <span className="text-fg">
          {usage && used !== null
            ? t('settings.vm.used', { size: formatGb(used, i18n.language) })
            : t('settings.vm.notCreated')}
        </span>
        {usage && (
          <span className="text-fg-muted">
            {t('settings.vm.limit', { size: formatGb(usage.virtualBytes, i18n.language) })}
          </span>
        )}
      </div>
      <span className="text-xs text-fg-muted">{t(`settings.vm.disks.${disk}.hint`)}</span>
    </section>
  )
}
