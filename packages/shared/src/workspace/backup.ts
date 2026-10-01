import { z } from 'zod'

import { AvatarColor } from '../bots/avatar'
import { endpoint } from '../http/endpoint'
import { WorkspaceSummary } from './workspace'

/** Left out of the `/workspace` archive by default (rebuilt by an install or a build). */
export const DEFAULT_BACKUP_EXCLUDES = ['node_modules', '.venv', 'target', 'dist', '.cache']

const ExcludePattern = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\n\r\0]+$/)

export const BackupJobKind = z.enum(['archive', 'disk'])
export type BackupJobKind = z.infer<typeof BackupJobKind>

export const BackupJobPhase = z.enum(['database', 'workspace', 'stopping_vm', 'disk', 'finishing'])
export type BackupJobPhase = z.infer<typeof BackupJobPhase>

/**
 * A backup running in the background (`archive`: zip with the database and optionally `/workspace`; `disk`:
 * compressed copy of the data disk).
 */
export const BackupJob = z.object({
  id: z.string(),
  kind: BackupJobKind,
  status: z.enum(['running', 'done', 'error', 'cancelled']),
  phase: BackupJobPhase,
  path: z.string(),
  progress: z.number().min(0).max(1).nullable(),
  bytesDone: z.number().int(),
  /** Estimate of what `bytesDone` goes up to (null: unknown). */
  bytesTotal: z.number().int().nullable(),
  /** Of the written file, once done. */
  outputBytes: z.number().int().nullable(),
  error: z.string().nullable(),
  startedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
})
export type BackupJob = z.infer<typeof BackupJob>

export const StartBackupBody = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('archive'),
    path: z.string().min(1),
    includeWorkspace: z.boolean().default(false),
    excludes: z.array(ExcludePattern).max(100).optional(),
  }),
  z.object({
    kind: z.literal('disk'),
    path: z.string().min(1),
    /** Stops a running VM for the copy and starts it again afterwards (without it: `conflict`). */
    stopVm: z.boolean().default(false),
  }),
])
export type StartBackupBody = z.input<typeof StartBackupBody>

const EstimateBackupBody = z.object({ excludes: z.array(ExcludePattern).max(100).optional() })
export const BackupEstimate = z.object({
  /** `/workspace` without the excludes, uncompressed. */
  workspaceBytes: z.number().int(),
})
export type BackupEstimate = z.infer<typeof BackupEstimate>

/** `/workspace` of the backup a workspace was imported from, restored once its VM is running. */
export const BackupRestore = z.object({
  status: z.enum(['pending', 'running', 'done', 'error', 'skipped']),
  path: z.string(),
  bytesDone: z.number().int(),
  bytesTotal: z.number().int(),
  error: z.string().nullable(),
  /** `file_missing`: the zip is no longer at `path` (choose it again). */
  errorReason: z.enum(['file_missing', 'no_workspace']).nullable().optional(),
  updatedAt: z.number().int(),
})
export type BackupRestore = z.infer<typeof BackupRestore>

const RetryBackupRestoreBody = z.object({ path: z.string().min(1).optional() })

const InspectBackupBody = z.object({ path: z.string().min(1) })
export const BackupInfo = z.object({
  workspaceName: z.string(),
  exportedAt: z.string().nullable(),
  milibotVersion: z.string().nullable(),
  /** Compressed size of the `/workspace` archive inside, null when it has none. */
  workspaceBytes: z.number().int().nullable(),
  bots: z.number().int(),
})
export type BackupInfo = z.infer<typeof BackupInfo>

const ImportWorkspaceBody = z.object({
  path: z.string().min(1),
  name: z.string().trim().min(1).max(64),
  color: AvatarColor,
})

export const backupEndpoints = {
  /** One at a time; progress in `backup.job` events. */
  startBackupJob: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/backup/jobs',
    body: StartBackupBody,
    response: BackupJob,
  }),
  /** The running backup, or the last one of this runtime. */
  getBackupJob: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/backup/job',
    response: BackupJob.nullable(),
  }),
  cancelBackupJob: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/backup/job/cancel',
    response: BackupJob.nullable(),
  }),
  /** Boots the VM if needed. */
  estimateBackup: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/backup/estimate',
    body: EstimateBackupBody,
    response: BackupEstimate,
  }),
  /** `/workspace` restore of an imported backup (null: the workspace was not imported with one). */
  getBackupRestore: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/backup/restore',
    response: BackupRestore.nullable(),
  }),
  /** Runs the restore again, optionally from another copy of the backup file. */
  retryBackupRestore: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/backup/restore/retry',
    body: RetryBackupRestoreBody,
    response: BackupRestore,
  }),
  skipBackupRestore: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/backup/restore/skip',
    response: BackupRestore,
  }),
  /** Reads the manifest of a backup zip. */
  inspectBackup: endpoint({
    method: 'POST',
    path: '/backups/inspect',
    body: InspectBackupBody,
    response: BackupInfo,
  }),
  /** The new workspace starts at the setup and restores `/workspace` once its VM runs. */
  importWorkspace: endpoint({
    method: 'POST',
    path: '/workspaces/import',
    body: ImportWorkspaceBody,
    response: WorkspaceSummary,
  }),
}
