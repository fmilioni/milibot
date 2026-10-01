import type { BackupInfo, BackupJob, BackupRestore, WorkspaceSummary } from '@milibot/shared'
import { useQueryClient } from '@tanstack/react-query'
import { CircleCheck, Download, FolderOpen, TriangleAlert, Upload, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/api/queries'
import { useApiQuery } from '@/api/use-api-query'
import {
  cancelBackupJob,
  getBackupJob,
  getBackupRestore,
  inspectBackup,
  retryBackupRestore,
  skipBackupRestore,
} from '@/features/settings/api'
import { ExportDialog } from '@/features/settings/backup/ExportDialog'
import { ImportDialog } from '@/features/settings/backup/ImportDialog'
import { useAppStore } from '@/features/workspace/store'
import { useApiMutation } from '@/features/workspace/use-api-mutation'
import { cn } from '@/lib/cn'
import { apiErrorReason } from '@/lib/errors'
import { formatBytes } from '@/lib/format'
import { Button } from '@/ui/Button'

import { Notice, SettingsRow } from './SettingsLayout'

function ProgressBar({ value }: { value: number | null }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3" aria-hidden>
      <div
        className={cn(
          'h-full rounded-full bg-accent transition-[width] duration-300',
          value === null && 'w-1/3 animate-pulse motion-reduce:animate-none',
        )}
        style={value === null ? undefined : { width: `${Math.max(2, Math.round(value * 100))}%` }}
      />
    </div>
  )
}

function JobStatus({
  job,
  onDismiss,
  onCancel,
}: {
  job: BackupJob
  onDismiss: () => void
  onCancel: () => void
}) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language
  if (job.status === 'running') {
    const detail =
      job.phase === 'workspace' && job.bytesTotal
        ? t('backup.progressBytes', {
            done: formatBytes(job.bytesDone, locale),
            total: formatBytes(job.bytesTotal, locale),
          })
        : job.phase === 'disk' && job.progress !== null
          ? `${Math.round(job.progress * 100)}%`
          : null
    return (
      <div className="flex flex-col gap-2 border-t border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="min-w-0 flex-1 truncate text-sm text-fg-secondary">
            {t(`backup.phase.${job.phase}`)}
            {detail ? ` · ${detail}` : ''}
          </span>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        </div>
        <ProgressBar value={job.progress} />
      </div>
    )
  }
  const tone = job.status === 'done' ? 'success' : job.status === 'error' ? 'danger' : 'neutral'
  const icon =
    job.status === 'done' ? (
      <CircleCheck size={14} className="text-success" />
    ) : (
      <TriangleAlert size={14} className={job.status === 'error' ? 'text-danger' : 'text-fg-muted'} />
    )
  return (
    <div className="border-t border-border px-4 py-3">
      <Notice
        tone={tone}
        icon={icon}
        action={
          <div className="flex items-center gap-1">
            {job.status === 'done' && (
              <Button size="sm" variant="ghost" onClick={() => void window.milibot.revealPath(job.path)}>
                <FolderOpen size={13} />
                {t('settings.general.reveal')}
              </Button>
            )}
            <button
              type="button"
              aria-label={t('common.close')}
              onClick={onDismiss}
              className="focus-ring flex size-6 items-center justify-center rounded text-fg-muted hover:bg-surface-3 hover:text-fg"
            >
              <X size={13} />
            </button>
          </div>
        }
      >
        {job.status === 'done'
          ? t('backup.done', { size: formatBytes(job.outputBytes ?? 0, locale) })
          : job.status === 'cancelled'
            ? t('backup.cancelled')
            : t('backup.failed', { error: job.error ?? '' })}
      </Notice>
    </div>
  )
}

function RestoreStatus({ restore, workspaceId }: { restore: BackupRestore; workspaceId: string }) {
  const { t, i18n } = useTranslation()
  const retryRestore = useApiMutation((path?: string) => retryBackupRestore(workspaceId, path))
  const skip = useApiMutation(() => skipBackupRestore(workspaceId))
  const retry = (path?: string) => void retryRestore.run(path)
  const choose = async () => {
    const path = await window.milibot.chooseOpenPath({ title: t('backup.importTitle'), extensions: ['zip'] })
    if (path) retry(path)
  }
  if (restore.status === 'skipped') return null
  if (restore.status === 'error')
    return (
      <div className="border-t border-border px-4 py-3">
        <Notice tone="danger" icon={<TriangleAlert size={14} className="text-danger" />}>
          <div className="flex flex-col gap-2">
            <span>
              {restore.errorReason === 'file_missing'
                ? t('backup.restoreFileMissing', { path: restore.path })
                : restore.errorReason === 'no_workspace'
                  ? t('backup.restoreNoWorkspace')
                  : t('backup.restoreFailed', { error: restore.error ?? '' })}
            </span>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="outline" onClick={() => retry()}>
                {t('common.retry')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void choose()}>
                {t('backup.chooseFile')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void skip.run()}>
                {t('backup.skip')}
              </Button>
            </div>
          </div>
        </Notice>
      </div>
    )
  const progress = restore.bytesTotal > 0 ? Math.min(1, restore.bytesDone / restore.bytesTotal) : null
  return (
    <div className="flex flex-col gap-2 border-t border-border px-4 py-3">
      <span className="text-sm text-fg-secondary">
        {restore.status === 'done'
          ? t('backup.restoreDone')
          : restore.status === 'pending'
            ? t('backup.restorePending')
            : t('backup.restoreRunning', {
                done: formatBytes(restore.bytesDone, i18n.language),
                total: formatBytes(restore.bytesTotal, i18n.language),
              })}
      </span>
      {restore.status === 'running' && <ProgressBar value={progress} />}
    </div>
  )
}

/** Rows of Settings › General › Data: export (zip, optional /workspace, disk copy), progress, restore and import. */
export function BackupRows({ workspace }: { workspace: WorkspaceSummary }) {
  const { t } = useTranslation()
  const showToast = useAppStore((s) => s.showToast)
  const [exporting, setExporting] = useState(false)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [importing, setImporting] = useState<{ path: string; info: BackupInfo } | null>(null)
  const workspaceId = workspace.id
  const queryClient = useQueryClient()
  // `backup.job`/`backup.restore` events write these keys (`api/cache-updates.ts`).
  const job = useApiQuery<BackupJob | null>(queryKeys.backupJob(workspaceId), () =>
    getBackupJob(workspaceId),
  ).data
  const restore = useApiQuery<BackupRestore | null>(queryKeys.backupRestore(workspaceId), () =>
    getBackupRestore(workspaceId),
  ).data
  const cancel = useApiMutation(() => cancelBackupJob(workspaceId))

  const chooseImport = async () => {
    const path = await window.milibot.chooseOpenPath({ title: t('backup.importTitle'), extensions: ['zip'] })
    if (!path) return
    try {
      setImporting({ path, info: await inspectBackup(path) })
    } catch (err) {
      const reason = apiErrorReason(err)
      showToast(
        reason === 'not_a_backup' ? 'backupInvalid' : reason === 'file_missing' ? 'backupMissing' : 'error',
      )
    }
  }

  const running = job?.status === 'running'
  return (
    <>
      <SettingsRow label={t('settings.general.backup')} hint={t('backup.rowHint')}>
        <Button size="sm" disabled={running} onClick={() => setExporting(true)}>
          <Download size={13} />
          {running ? t('settings.general.exporting') : t('settings.general.export')}
        </Button>
      </SettingsRow>
      {job && job.id !== dismissed && (
        <JobStatus job={job} onDismiss={() => setDismissed(job.id)} onCancel={() => void cancel.run()} />
      )}
      {restore && <RestoreStatus restore={restore} workspaceId={workspaceId} />}
      <SettingsRow label={t('backup.importRow')} hint={t('backup.importRowHint')}>
        <Button size="sm" onClick={() => void chooseImport()}>
          <Upload size={13} />
          {t('backup.importButton')}
        </Button>
      </SettingsRow>
      {exporting && (
        <ExportDialog
          workspace={workspace}
          onClose={() => setExporting(false)}
          onStarted={(started) => {
            setDismissed(null)
            queryClient.setQueryData(queryKeys.backupJob(workspaceId), started)
          }}
        />
      )}
      {importing && (
        <ImportDialog path={importing.path} info={importing.info} onClose={() => setImporting(null)} />
      )}
    </>
  )
}
