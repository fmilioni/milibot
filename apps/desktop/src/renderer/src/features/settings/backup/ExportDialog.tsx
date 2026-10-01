import { type BackupJob, DEFAULT_BACKUP_EXCLUDES, slugify, type WorkspaceSummary } from '@milibot/shared'
import { Download, HardDrive, TriangleAlert, X } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/api/queries'
import { useApiQuery } from '@/api/use-api-query'
import { estimateBackup, getVmDetails, startBackupJob } from '@/features/settings/api'
import { Notice } from '@/features/settings/SettingsLayout'
import { useApiMutation } from '@/features/workspace/use-api-mutation'
import { cn } from '@/lib/cn'
import { apiErrorReason } from '@/lib/errors'
import { formatBytes } from '@/lib/format'
import { Button } from '@/ui/Button'
import { Modal } from '@/ui/Modal'
import { Switch } from '@/ui/Switch'
import { TextInput } from '@/ui/TextInput'

function ExcludeList({ value, onChange }: { value: string[]; onChange: (value: string[]) => void }) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')
  const add = () => {
    const pattern = draft.trim()
    if (pattern && !value.includes(pattern)) onChange([...value, pattern])
    setDraft('')
  }
  const isDefault =
    value.length === DEFAULT_BACKUP_EXCLUDES.length && DEFAULT_BACKUP_EXCLUDES.every((e) => value.includes(e))
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-fg-secondary">{t('backup.excludes')}</span>
        {!isDefault && (
          <button
            type="button"
            className="focus-ring rounded text-xs font-medium text-accent hover:underline"
            onClick={() => onChange([...DEFAULT_BACKUP_EXCLUDES])}
          >
            {t('backup.excludesReset')}
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {value.map((pattern) => (
          <span
            key={pattern}
            className="inline-flex h-6 items-center gap-1 rounded-md bg-surface-3 pr-1 pl-2 font-mono text-xs text-fg"
          >
            {pattern}
            <button
              type="button"
              aria-label={t('backup.excludeRemove', { pattern })}
              onClick={() => onChange(value.filter((p) => p !== pattern))}
              className="focus-ring flex size-4 items-center justify-center rounded text-fg-muted hover:bg-surface-2 hover:text-fg"
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <form
          className="flex"
          onSubmit={(e) => {
            e.preventDefault()
            add()
          }}
        >
          <TextInput
            value={draft}
            maxLength={200}
            spellCheck={false}
            placeholder={t('backup.excludeAdd')}
            aria-label={t('backup.excludeAdd')}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={add}
            className="!h-6 w-40 font-mono !text-xs"
          />
        </form>
      </div>
      <p className="text-xs leading-[15px] text-fg-muted">{t('backup.excludesHint')}</p>
    </div>
  )
}

/** For the exclusions in `key`; another key means a new estimate is on its way. */
type Estimate = { key: string } & ({ state: 'ready'; bytes: number } | { state: 'error' })

export function ExportDialog({
  workspace,
  onClose,
  onStarted,
}: {
  workspace: WorkspaceSummary
  onClose: () => void
  onStarted: (job: BackupJob) => void
}) {
  const { t, i18n } = useTranslation()
  const [kind, setKind] = useState<'archive' | 'disk'>('archive')
  const [includeWorkspace, setIncludeWorkspace] = useState(false)
  const [excludes, setExcludes] = useState<string[]>([...DEFAULT_BACKUP_EXCLUDES])
  const [advanced, setAdvanced] = useState(false)
  const [estimate, setEstimate] = useState<Estimate | null>(null)
  const [error, setError] = useState<string | null>(null)
  const startJob = useApiMutation(
    (path: string) =>
      startBackupJob(
        workspace.id,
        kind === 'archive'
          ? { kind, path, includeWorkspace, ...(includeWorkspace ? { excludes } : {}) }
          : { kind, path, stopVm: true },
      ),
    { errorToast: false },
  )
  const busy = startJob.busy

  const { data: details } = useApiQuery(queryKeys.vmDetails(workspace.id), () => getVmDetails(workspace.id))

  const excludesKey = excludes.join('\n')
  useEffect(() => {
    if (!includeWorkspace || kind !== 'archive') return
    let active = true
    const timer = setTimeout(() => {
      estimateBackup(workspace.id, excludesKey ? excludesKey.split('\n') : [])
        .then((r) => active && setEstimate({ key: excludesKey, state: 'ready', bytes: r.workspaceBytes }))
        .catch(() => active && setEstimate({ key: excludesKey, state: 'error' }))
    }, 300)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [includeWorkspace, excludesKey, kind, workspace.id])
  const currentEstimate = estimate?.key === excludesKey ? estimate : null

  const vmRunning = details ? details.vm.state === 'running' || details.vm.state === 'starting' : false
  const dataDisk = details?.disks.data ?? null

  const start = async () => {
    const date = new Date().toISOString().slice(0, 10)
    const extension = kind === 'archive' ? 'zip' : 'qcow2'
    const path = await window.milibot.chooseSavePath({
      defaultName: `milibot-${slugify(workspace.name, { fallback: 'workspace' })}-${date}${kind === 'disk' ? `-${t('backup.diskFileSuffix')}` : ''}.${extension}`,
      title: t('backup.saveTitle'),
      extension,
    })
    if (!path) return
    setError(null)
    try {
      const job = await startJob.run(path)
      if (!job) return
      onStarted(job)
      onClose()
    } catch (err) {
      const reason = apiErrorReason(err)
      setError(reason ? t(`backup.errors.${reason}`, { defaultValue: t('toast.error') }) : t('toast.error'))
    }
  }

  const option = (value: 'archive' | 'disk', title: string, hint: string, icon: ReactNode) => (
    <label
      className={cn(
        'flex cursor-pointer gap-3 rounded-[10px] border px-3.5 py-3 transition',
        kind === value ? 'border-accent bg-accent-soft/40' : 'border-border hover:bg-surface-3/60',
      )}
    >
      <input
        type="radio"
        name="backup-kind"
        className="mt-1 accent-accent"
        checked={kind === value}
        onChange={() => setKind(value)}
      />
      <span className="mt-0.5 shrink-0 text-fg-secondary" aria-hidden>
        {icon}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-base font-semibold text-fg">{title}</span>
        <span className="text-sm leading-[17px] text-fg-secondary">{hint}</span>
      </span>
    </label>
  )

  return (
    <Modal title={t('backup.dialogTitle')} width={560} onClose={onClose} closeLabel={t('common.close')}>
      <div className="flex flex-col gap-3.5">
        {option('archive', t('backup.archive'), t('backup.archiveHint'), <Download size={16} />)}
        {kind === 'archive' && (
          <div className="flex flex-col gap-3 rounded-[10px] bg-surface-3/60 px-3.5 py-3">
            <div className="flex items-start gap-3">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-base font-medium text-fg">{t('backup.includeWorkspace')}</span>
                <span className="text-sm leading-[17px] text-fg-secondary">
                  {!includeWorkspace
                    ? t('backup.includeWorkspaceHint')
                    : currentEstimate?.state === 'ready'
                      ? t('backup.estimate', { size: formatBytes(currentEstimate.bytes, i18n.language) })
                      : currentEstimate?.state === 'error'
                        ? t('backup.estimateError')
                        : t('backup.estimating')}
                </span>
              </div>
              <Switch
                checked={includeWorkspace}
                label={t('backup.includeWorkspace')}
                onChange={setIncludeWorkspace}
              />
            </div>
            {includeWorkspace && <ExcludeList value={excludes} onChange={setExcludes} />}
          </div>
        )}
        <button
          type="button"
          aria-expanded={advanced || kind === 'disk'}
          onClick={() => setAdvanced(!advanced)}
          className="focus-ring self-start rounded text-sm font-medium text-fg-secondary hover:text-fg"
        >
          {advanced || kind === 'disk' ? '▾' : '▸'} {t('backup.advanced')}
        </button>
        {(advanced || kind === 'disk') &&
          option(
            'disk',
            t('backup.disk'),
            dataDisk
              ? t('backup.diskHint', {
                  used: formatBytes(dataDisk.actualBytes ?? dataDisk.virtualBytes, i18n.language),
                  max: formatBytes(dataDisk.virtualBytes, i18n.language),
                })
              : t('backup.diskNoVm'),
            <HardDrive size={16} />,
          )}
        {kind === 'disk' && (
          <Notice icon={<TriangleAlert size={14} className="text-warning" />} tone="warning">
            {vmRunning ? t('backup.diskStopsVm') : t('backup.diskStoppedVm')}
          </Notice>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            data-autofocus
            disabled={busy || (kind === 'disk' && !dataDisk)}
            onClick={() => void start()}
          >
            {t('backup.chooseAndExport')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
