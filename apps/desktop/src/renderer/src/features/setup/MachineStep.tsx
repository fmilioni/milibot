import {
  type GoldenStatus,
  type HostInfo,
  LEGACY_OFFICE_INSTALL_MB,
  matchPreset,
  presetFits,
  VM_PRESETS,
  VM_SIZE_LIMITS,
  type VmSize,
} from '@milibot/shared'
import { ChevronDown, ChevronRight, Circle, CircleAlert, CircleCheck, Play, RotateCw } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { etaText, type SetupVmProgress } from '@/features/setup/lib/setup'
import { cn } from '@/lib/cn'
import { formatBytes } from '@/lib/format'
import { Button } from '@/ui/Button'
import { Checkbox } from '@/ui/Checkbox'
import { Spinner } from '@/ui/Spinner'
import { Tooltip } from '@/ui/Tooltip'

function SizeStepper({
  label,
  value,
  gb = false,
  min,
  max,
  step,
  hint,
  onChange,
}: {
  label: string
  value: number
  gb?: boolean
  min: number
  max: number
  step: number
  hint: string
  onChange: (value: number) => void
}) {
  const { t } = useTranslation()
  const button =
    'focus-ring flex size-6 items-center justify-center rounded text-md text-fg-secondary hover:bg-surface-3 disabled:opacity-40'
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-xs font-medium text-fg-secondary">{label}</span>
      <div
        role="group"
        aria-label={label}
        className="flex h-[29px] items-center rounded-[7px] border border-border bg-surface-2 px-1"
      >
        <button
          type="button"
          className={button}
          aria-label={t('setup.machine.decrease', { name: label })}
          disabled={value <= min}
          onClick={() => onChange(Math.max(min, value - step))}
        >
          −
        </button>
        <span className="flex-1 text-center text-base font-semibold text-fg tabular-nums" aria-live="polite">
          {gb ? t('common.gb', { value }) : value}
        </span>
        <button
          type="button"
          className={button}
          aria-label={t('setup.machine.increase', { name: label })}
          disabled={value >= max}
          onClick={() => onChange(Math.min(max, value + step))}
        >
          +
        </button>
      </div>
      <span className="text-xs text-fg-muted">{hint}</span>
    </div>
  )
}

export function MachineSizePicker({
  size,
  host,
  onChange,
}: {
  size: VmSize
  host: HostInfo | null
  onChange: (size: VmSize) => void
}) {
  const { t } = useTranslation()
  const selected = matchPreset(size)
  const [customOpen, setCustomOpen] = useState(selected === null)
  const limits = host ?? { maxVmCpus: 64, maxVmMemoryGb: 512 }

  return (
    <div className="flex flex-col gap-2">
      <div role="radiogroup" aria-label={t('setup.machine.title')} className="grid grid-cols-3 gap-2">
        {VM_PRESETS.map((preset) => {
          const fits = presetFits(preset, limits)
          const active = selected === preset.id
          const card = (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={active}
              aria-disabled={!fits}
              onClick={() =>
                fits && onChange({ cpus: preset.cpus, memGb: preset.memGb, dataGb: preset.dataGb })
              }
              className={cn(
                'flex w-full flex-col gap-0.5 rounded-[10px] border px-3 py-2.5 text-left transition-colors outline-none focus-visible:border-accent',
                active ? 'border-accent bg-accent-soft' : 'border-border bg-surface-2 hover:bg-surface-3/60',
                !fits && 'opacity-50',
              )}
            >
              <span className="flex items-center justify-between">
                <span className={cn('text-base font-semibold', active ? 'text-accent' : 'text-fg')}>
                  {t(`setup.machine.presets.${preset.id}.name`)}
                </span>
                {active && <CircleCheck size={13} className="text-accent" aria-hidden />}
              </span>
              <span className={cn('text-xs', active ? 'text-accent' : 'text-fg-secondary')}>
                {t('setup.machine.specs', { cpus: preset.cpus, mem: preset.memGb, disk: preset.dataGb })}
              </span>
              <span className={cn('text-xs', active ? 'text-accent/80' : 'text-fg-muted')}>
                {t(`setup.machine.presets.${preset.id}.fit`)}
              </span>
            </button>
          )
          return fits ? (
            card
          ) : (
            <Tooltip
              key={preset.id}
              content={t('setup.machine.tooBig', { cpus: limits.maxVmCpus, mem: limits.maxVmMemoryGb })}
            >
              {card}
            </Tooltip>
          )
        })}
      </div>
      <div className="rounded-[10px] border border-border bg-surface-2">
        <button
          type="button"
          aria-expanded={customOpen}
          onClick={() => setCustomOpen(!customOpen)}
          className="focus-ring flex w-full items-center gap-1.5 rounded-[10px] px-3 py-2.5 text-sm font-semibold text-fg"
        >
          {customOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {t('setup.machine.customize')}
        </button>
        {customOpen && (
          <div className="flex flex-col gap-2.5 px-3 pb-3">
            <div className="flex gap-2.5">
              <SizeStepper
                label={t('setup.machine.cpus')}
                value={size.cpus}
                min={VM_SIZE_LIMITS.minCpus}
                max={limits.maxVmCpus}
                step={1}
                hint={t('setup.machine.max', { value: limits.maxVmCpus })}
                onChange={(cpus) => onChange({ ...size, cpus })}
              />
              <SizeStepper
                label={t('setup.machine.memory')}
                value={size.memGb}
                gb
                min={VM_SIZE_LIMITS.minMemGb}
                max={limits.maxVmMemoryGb}
                step={1}
                hint={t('setup.machine.maxGb', { value: limits.maxVmMemoryGb })}
                onChange={(memGb) => onChange({ ...size, memGb })}
              />
              <SizeStepper
                label={t('setup.machine.disk')}
                value={size.dataGb}
                gb
                min={VM_SIZE_LIMITS.minDataGb}
                max={VM_SIZE_LIMITS.maxDataGb}
                step={VM_SIZE_LIMITS.dataStepGb}
                hint={t('setup.machine.grows')}
                onChange={(dataGb) => onChange({ ...size, dataGb })}
              />
            </div>
            <p className="text-xs leading-[1.4] text-fg-muted">{t('setup.machine.diskNote')}</p>
          </div>
        )}
      </div>
    </div>
  )
}

export function CreateMachineButton({
  minutes,
  busy,
  disabled,
  onClick,
}: {
  minutes: number
  busy: boolean
  disabled: boolean
  onClick: () => void
}) {
  const { t } = useTranslation()
  return (
    <Button variant="primary" className="w-fit" disabled={disabled || busy} onClick={onClick}>
      {busy ? <Spinner size={13} /> : <Play size={12} />}
      {busy ? t('setup.machine.saving') : t('setup.machine.create', { minutes })}
    </Button>
  )
}

function ItemIcon({ state }: { state: SetupVmProgress['items'][number]['state'] }) {
  if (state === 'done') return <CircleCheck size={13} className="shrink-0 text-success" aria-hidden />
  if (state === 'active') return <Spinner size={13} className="text-accent" />
  if (state === 'error') return <CircleAlert size={13} className="shrink-0 text-danger" aria-hidden />
  return <Circle size={13} className="shrink-0 text-fg-muted" aria-hidden />
}

export function MachineProgress({
  progress,
  golden,
  vmError,
  onRetry,
  onUseCurrent,
  retrying,
}: {
  progress: SetupVmProgress
  golden: GoldenStatus | null
  vmError: string | null
  onRetry: () => void
  /** Creates the VM on the outdated image when its newer version could not be prepared. */
  onUseCurrent: () => void
  retrying: boolean
}) {
  const { t, i18n } = useTranslation()
  const eta = progress.etaSeconds === null ? null : etaText(progress.etaSeconds, t)
  const label = (key: SetupVmProgress['items'][number]['key']) =>
    key === 'download' && golden?.downloadBytes
      ? t('setup.machine.items.downloadSize', { size: formatBytes(golden.downloadBytes, i18n.language) })
      : t(`setup.machine.items.${key}`)

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border bg-surface-2 px-3 py-3">
      {progress.updatingSystem && !progress.failed && (
        <p className="text-sm font-medium text-fg">{t('setup.machine.updatingSystem')}</p>
      )}
      <ul className="flex flex-col gap-[7px]">
        {progress.items.map((item) => (
          <li
            key={item.key}
            className={cn(
              'flex items-center gap-2 text-sm',
              item.state === 'pending' ? 'text-fg-muted' : item.state === 'error' ? 'text-danger' : 'text-fg',
            )}
          >
            <ItemIcon state={item.state} />
            {label(item.key)}
          </li>
        ))}
      </ul>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
        className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3"
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-700',
            progress.failed ? 'bg-danger' : 'bg-accent',
          )}
          style={{ width: `${Math.max(2, progress.percent)}%` }}
        />
      </div>
      {progress.failed ? (
        <div className="flex items-center gap-3">
          <p className="selectable min-w-0 flex-1 text-xs text-danger">
            {progress.failed === 'vm'
              ? t('setup.machine.vmFailed', { error: vmError ?? '' })
              : progress.updatingSystem
                ? t('setup.machine.updateFailed', { error: golden?.error ?? '' })
                : t('setup.machine.goldenFailed', { error: golden?.error ?? '' })}
          </p>
          {progress.failed === 'golden' && progress.updatingSystem && (
            <Tooltip content={t('setup.machine.useCurrentHint')}>
              <Button
                size="sm"
                variant="ghost"
                className="shrink-0"
                onClick={onUseCurrent}
                disabled={retrying}
              >
                {t('setup.machine.useCurrent')}
              </Button>
            </Tooltip>
          )}
          <Button size="sm" className="shrink-0" onClick={onRetry} disabled={retrying}>
            <RotateCw size={12} />
            {t('common.retry')}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-fg-muted">
          {[t('setup.machine.percent', { percent: progress.percent }), eta, t('setup.machine.keepGoing')]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
    </div>
  )
}

/** "Read old Office files" (off by default), saved as the workspace preference. */
export function LegacyOfficeOption({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  const { t } = useTranslation()
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-[10px] border border-border bg-surface-2 px-3 py-2.5 hover:bg-surface-3/60">
      <span className="mt-px flex">
        <Checkbox checked={checked} onChange={onChange} label={t('setup.machine.legacyOffice.label')} />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-semibold text-fg">{t('setup.machine.legacyOffice.label')}</span>
        <span className="text-xs leading-[1.4] text-fg-muted">
          {t('setup.machine.legacyOffice.hint', { size: LEGACY_OFFICE_INSTALL_MB })}
        </span>
      </span>
    </label>
  )
}
