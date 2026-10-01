import { type VmDetails, type VmDiskKind } from '@milibot/shared'
import { Check, CircleArrowUp, Database, Plus, RotateCw, TriangleAlert, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Notice } from '@/features/settings/SettingsLayout'
import { cn } from '@/lib/cn'
import { Button } from '@/ui/Button'
import { Modal } from '@/ui/Modal'
import { TextInput } from '@/ui/TextInput'

import { useRevisionTexts } from './SystemUpdate'

export function GrowDiskDialog({
  disk,
  currentGb,
  running,
  onClose,
  onConfirm,
}: {
  disk: VmDiskKind
  currentGb: number
  running: boolean
  onClose: () => void
  onConfirm: (sizeGb: number) => void
}) {
  const { t } = useTranslation()
  const [size, setSize] = useState(String(currentGb + (disk === 'data' ? 20 : 10)))
  const value = Number(size)
  const valid = Number.isInteger(value) && value > currentGb && value <= 4096
  return (
    <Modal
      title={t('settings.vm.growTitle', { disk: t(`settings.vm.disks.${disk}.title`) })}
      description={t('settings.vm.growDescription', { size: currentGb })}
      width={440}
      onClose={onClose}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (valid) onConfirm(value)
        }}
      >
        <label className="flex items-center gap-2">
          <span className="text-base text-fg-secondary">{t('settings.vm.newSize')}</span>
          <TextInput
            data-autofocus
            inputMode="numeric"
            className="w-24 text-right tabular-nums"
            value={size}
            onChange={(e) => setSize(e.target.value.replace(/\D/g, ''))}
          />
          <span className="text-base text-fg-secondary">{t('common.gbUnit')}</span>
        </label>
        {running && (
          <Notice icon={<TriangleAlert size={14} className="text-warning" />} tone="warning">
            {t('settings.vm.restartWarning')}
          </Notice>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" disabled={!valid}>
            {t('settings.vm.grow')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/** What replacing the system disk erases and keeps (reset and system update). */
function SystemChanges() {
  const { t } = useTranslation()
  const erased = ['programs', 'images', 'volumes', 'snapshots'] as const
  const kept = ['workspace', 'bots', 'chrome', 'keys'] as const
  return (
    <>
      <div className="grid grid-cols-2 gap-2.5">
        <div className="flex flex-col gap-1.5 rounded-[10px] bg-danger-tint px-3 py-2.5">
          <span className="text-sm font-semibold text-danger">{t('settings.vm.reset.erasedTitle')}</span>
          {erased.map((key) => (
            <span key={key} className="flex items-center gap-2 text-sm text-fg">
              <X size={12} className="shrink-0 text-danger" aria-hidden />
              {t(`settings.vm.reset.erased.${key}`)}
            </span>
          ))}
        </div>
        <div className="flex flex-col gap-1.5 rounded-[10px] bg-success-soft px-3 py-2.5">
          <span className="text-sm font-semibold text-success">{t('settings.vm.reset.keptTitle')}</span>
          {kept.map((key) => (
            <span key={key} className="flex items-center gap-2 text-sm text-fg">
              <Check size={12} className="shrink-0 text-success" aria-hidden />
              {t(`settings.vm.reset.kept.${key}`)}
            </span>
          ))}
        </div>
      </div>
      <Notice icon={<Database size={14} className="text-warning" />} tone="warning">
        {t('settings.vm.reset.backupHint')}
      </Notice>
    </>
  )
}

export function UpdateSystemDialog({
  details,
  onClose,
  onConfirm,
}: {
  details: VmDetails
  onClose: () => void
  onConfirm: (whenIdle: boolean) => void
}) {
  const { t } = useTranslation()
  const [whenIdle, setWhenIdle] = useState(true)
  const { changes } = useRevisionTexts(details)
  const running = details.vm.state === 'running' || details.vm.state === 'starting'
  const option = (value: boolean, label: string) => (
    <label className="flex cursor-pointer items-center gap-2.5 text-base text-fg">
      <input
        type="radio"
        name="system-update-when"
        className="size-4 accent-accent"
        checked={whenIdle === value}
        onChange={() => setWhenIdle(value)}
      />
      {label}
    </label>
  )
  return (
    <Modal
      title={t('settings.vm.update.title')}
      icon={<CircleArrowUp size={18} />}
      width={560}
      onClose={onClose}
      showClose={false}
    >
      <form
        className="-mt-1 flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          onConfirm(whenIdle)
        }}
      >
        <p className="text-base leading-[1.55] text-fg-secondary">
          {running ? t('settings.vm.update.body') : t('settings.vm.update.bodyStopped')}
        </p>
        {changes.length > 0 && (
          <div className="flex flex-col gap-1.5 rounded-[10px] bg-surface-3 px-3 py-2.5">
            <span className="text-sm font-semibold text-fg">{t('settings.vm.update.changesTitle')}</span>
            {changes.map((line) => (
              <span key={line} className="flex items-center gap-2 text-sm text-fg">
                <Plus size={12} className="shrink-0 text-accent" aria-hidden />
                {line}
              </span>
            ))}
          </div>
        )}
        <SystemChanges />
        {running && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-sm text-fg-secondary">{t('settings.vm.update.whenLabel')}</legend>
            {option(true, t('settings.vm.update.whenIdle'))}
            {option(false, t('settings.vm.update.asap'))}
          </fieldset>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" data-autofocus>
            <CircleArrowUp size={13} />
            {t('settings.vm.update.confirm')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

export function ResetVmDialog({ onClose, onConfirm }: { onClose: () => void; onConfirm: () => void }) {
  const { t } = useTranslation()
  const [typed, setTyped] = useState('')
  const word = t('settings.vm.reset.word')
  const matches = typed.trim().toUpperCase() === word
  return (
    <Modal title={t('settings.vm.reset.title')} width={540} onClose={onClose} showClose={false}>
      <form
        className="-mt-1 flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (matches) onConfirm()
        }}
      >
        <p className="text-base leading-[1.55] text-fg-secondary">{t('settings.vm.reset.body')}</p>
        <SystemChanges />
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-fg-secondary">
            {t('settings.vm.reset.typeLabel', { word })}
          </span>
          <TextInput
            data-autofocus
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setTyped(e.target.value)}
            className={cn('font-mono', typed && !matches && 'border-danger-soft')}
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="danger" type="submit" disabled={!matches}>
            <RotateCw size={13} />
            {t('settings.vm.reset.confirm')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
