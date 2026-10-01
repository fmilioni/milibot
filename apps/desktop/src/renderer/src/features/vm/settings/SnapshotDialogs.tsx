import { SNAPSHOT_NAME_PATTERN, type VmDetails } from '@milibot/shared'
import { Camera, History, RotateCcw, Trash2, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Notice } from '@/features/settings/SettingsLayout'
import { cn } from '@/lib/cn'
import { Button } from '@/ui/Button'
import { Modal } from '@/ui/Modal'
import { TextInput } from '@/ui/TextInput'

export function SnapshotsDialog({
  details,
  onClose,
  onRestore,
  onDelete,
}: {
  details: VmDetails
  onClose: () => void
  onRestore: (name: string) => void
  onDelete: (name: string) => void
}) {
  const { t, i18n } = useTranslation()
  const [confirm, setConfirm] = useState<string | null>(null)
  const running = details.vm.state === 'running'
  return (
    <Modal
      title={t('settings.vm.restoreTitle')}
      description={t('settings.vm.restoreDescription')}
      width={520}
      onClose={onClose}
    >
      {details.snapshots.length === 0 ? (
        <p className="rounded-[10px] border border-dashed border-border px-4 py-5 text-center text-base text-fg-muted">
          {t('settings.vm.noSnapshots')}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-[10px] border border-border">
          {details.snapshots.map((snap) => (
            <li key={snap.name} className="flex items-center gap-3 px-3.5 py-2.5">
              <History size={14} className="shrink-0 text-fg-secondary" aria-hidden />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-mono text-sm text-fg">{snap.name}</span>
                {snap.createdAt && (
                  <span className="text-xs text-fg-muted">
                    {new Intl.DateTimeFormat(i18n.language, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(snap.createdAt)}
                  </span>
                )}
              </div>
              {confirm === snap.name ? (
                <>
                  <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                    {t('common.cancel')}
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => onRestore(snap.name)}>
                    {t('settings.vm.restoreConfirm')}
                  </Button>
                </>
              ) : (
                <>
                  <Button size="sm" onClick={() => setConfirm(snap.name)}>
                    <RotateCcw size={12} />
                    {t('settings.vm.restore')}
                  </Button>
                  <button
                    type="button"
                    aria-label={t('settings.vm.deleteSnapshot', { name: snap.name })}
                    onClick={() => onDelete(snap.name)}
                    className="focus-ring flex size-6 items-center justify-center rounded text-fg-muted hover:bg-surface-3 hover:text-danger"
                  >
                    <Trash2 size={13} />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {confirm && (
        <Notice icon={<TriangleAlert size={14} className="text-warning" />} tone="warning">
          {running ? t('settings.vm.restoreWarningRunning') : t('settings.vm.restoreWarning')}
        </Notice>
      )}
    </Modal>
  )
}

export function CreateSnapshotDialog({
  running,
  onClose,
  onConfirm,
}: {
  running: boolean
  onClose: () => void
  onConfirm: (name: string | undefined) => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const valid = !name || SNAPSHOT_NAME_PATTERN.test(name)
  return (
    <Modal
      title={t('settings.vm.createSnapshotTitle')}
      description={t('settings.vm.createSnapshotDescription')}
      width={460}
      onClose={onClose}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (valid) onConfirm(name || undefined)
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-fg-secondary">{t('settings.vm.snapshotName')}</span>
          <TextInput
            data-autofocus
            value={name}
            placeholder={t('settings.vm.snapshotNamePlaceholder')}
            onChange={(e) => setName(e.target.value.replace(/\s+/g, '-'))}
            className={cn('font-mono', !valid && 'border-danger-soft')}
          />
        </label>
        {running && (
          <Notice icon={<TriangleAlert size={14} className="text-warning" />} tone="warning">
            {t('settings.vm.restartWarning')}
          </Notice>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" disabled={!valid}>
            <Camera size={13} />
            {t('settings.vm.createSnapshot')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
