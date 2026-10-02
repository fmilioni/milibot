import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rename, rm, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { createGunzip } from 'node:zlib'

import {
  type backupEndpoints,
  type BackupEstimate,
  type BackupJob,
  type BackupRestore,
  DEFAULT_BACKUP_EXCLUDES,
  type LogFn,
  newId,
  type StartBackupBody,
  type WorkspaceEvent,
} from '@milibot/shared'
import type { z } from 'zod'

import {
  BACKUP_RESTORE_KEY,
  WORKSPACE_ENTRY,
  type WriteBackupInput,
  writeBackupZip,
} from '../../backup/archive'
import type { Db } from '../../db/sqlite'
import { DaemonError, errorMessage } from '../../errors'
import type { EndpointHandlers } from '../../handlers'
import { requireTarget } from '../../util/fs'
import { ZipReader } from '../../util/zip'
import { type VmController, whenVmRunning } from '../vm'

class RestoreError extends Error {
  constructor(
    message: string,
    readonly reason: NonNullable<BackupRestore['errorReason']>,
  ) {
    super(message)
  }
}
const PROGRESS_EVERY_MS = 250

type StartBody = z.output<typeof StartBackupBody>

export interface BackupDeps {
  db: Db
  workspaceDir: string
  workspaceName: () => string
  version: string
  vm: VmController
  getSetting: <T>(key: string, fallback: T) => T
  setSetting: (key: string, value: unknown) => void
  /** The workspace is still in its setup (no VM yet): the restore waits. */
  vmPending: () => boolean
  emit: (event: WorkspaceEvent) => void
  now: () => number
  qemuImg: () => string | null
  log: LogFn
}

/** Size of the tar of `/workspace`: contents plus a 512-byte header and half a block of padding per entry. */
function tarSizeEstimate(estimate: { bytes: number; entries?: number }): number {
  return estimate.bytes + (estimate.entries ?? 0) * 768 + 10_240
}

/** `qemu-img convert -p` prints `    (12.34/100%)` separated by carriage returns. */
export function parseQemuImgProgress(output: string): number | null {
  const matches = [...output.matchAll(/\((\d+(?:\.\d+)?)\/100%\)/g)]
  const last = matches.at(-1)?.[1]
  return last === undefined ? null : Math.min(1, Number(last) / 100)
}

export function qemuImgConvertArgs(source: string, target: string): string[] {
  return ['convert', '-p', '-O', 'qcow2', '-c', source, target]
}

/**
 * Backups of the settings screen (a zip with the database and optionally `/workspace`, or a compressed copy
 * of the data disk) as background jobs, and the `/workspace` restore of an imported backup.
 */
export class BackupService {
  private job: BackupJob | null = null
  private controller: AbortController | null = null
  private restoring: Promise<void> | null = null
  private restoreAbort: AbortController | null = null
  private lastEmit = 0
  private unsubscribe: (() => void) | null = null

  constructor(private readonly deps: BackupDeps) {}

  start(): void {
    this.unsubscribe = whenVmRunning(this.deps.vm, () => this.maybeRestore())
  }

  stop(): void {
    this.unsubscribe?.()
    this.controller?.abort()
    this.restoreAbort?.abort()
  }

  handlers(): EndpointHandlers<Exclude<keyof typeof backupEndpoints, 'inspectBackup' | 'importWorkspace'>> {
    return {
      startBackupJob: ({ body }) => this.begin(body),
      getBackupJob: () => this.current(),
      cancelBackupJob: () => this.cancel(),
      estimateBackup: ({ body }) => this.estimate(body.excludes),
      getBackupRestore: () => this.restore(),
      retryBackupRestore: ({ body }) => this.retryRestore(body.path),
      skipBackupRestore: () => this.skipRestore(),
    }
  }

  current(): BackupJob | null {
    return this.job
  }

  private emitJob(force = false): void {
    if (!this.job) return
    const at = this.deps.now()
    if (!force && at - this.lastEmit < PROGRESS_EVERY_MS) return
    this.lastEmit = at
    this.deps.emit({ type: 'backup.job', payload: { job: this.job } })
  }

  private update(patch: Partial<BackupJob>, force = true): void {
    if (!this.job) return
    this.job = { ...this.job, ...patch }
    this.emitJob(force)
  }

  /** Validates what can fail right away (answered as an API error), then runs in the background. */
  begin(body: StartBody): BackupJob {
    if (this.job?.status === 'running') throw new DaemonError('conflict', 'A backup is already running')
    if (body.kind === 'archive') requireTarget(body.path, '.zip')
    else {
      requireTarget(body.path, '.qcow2')
      if (!existsSync(this.dataDisk()))
        throw new DaemonError('conflict', 'The workspace VM has not been created yet', { reason: 'no_vm' })
      if (!this.deps.qemuImg())
        throw new DaemonError('conflict', 'qemu-img was not found (reinstall Milibot)', { reason: 'no_qemu' })
      if (this.deps.vm.processRunning() && !body.stopVm)
        throw new DaemonError('conflict', 'Stop the VM to copy its data disk', { reason: 'vm_running' })
    }
    const controller = new AbortController()
    this.controller = controller
    this.job = {
      id: newId('backup'),
      kind: body.kind,
      status: 'running',
      phase: body.kind === 'archive' ? 'database' : 'disk',
      path: body.path,
      progress: null,
      bytesDone: 0,
      bytesTotal: null,
      outputBytes: null,
      error: null,
      startedAt: this.deps.now(),
      finishedAt: null,
    }
    const job = this.job
    const run =
      body.kind === 'archive'
        ? this.runArchive(body, controller.signal)
        : this.runDisk(body, controller.signal)
    void run
      .then((bytes) => {
        if (this.job?.id !== job.id) return
        this.update({ status: 'done', progress: 1, outputBytes: bytes, finishedAt: this.deps.now() })
      })
      .catch((err: unknown) => {
        if (this.job?.id !== job.id) return
        const cancelled = controller.signal.aborted
        if (!cancelled) this.deps.log('error', 'backup failed', { kind: body.kind, err: errorMessage(err) })
        this.update({
          status: cancelled ? 'cancelled' : 'error',
          error: cancelled ? null : errorMessage(err),
          finishedAt: this.deps.now(),
        })
      })
      .finally(() => {
        if (this.controller === controller) this.controller = null
      })
    this.emitJob(true)
    return this.job
  }

  cancel(): BackupJob | null {
    this.controller?.abort()
    return this.job
  }

  private async runArchive(
    body: Extract<StartBody, { kind: 'archive' }>,
    signal: AbortSignal,
  ): Promise<number> {
    const excludes = body.excludes ?? DEFAULT_BACKUP_EXCLUDES
    let workspace: WriteBackupInput['workspace']
    if (body.includeWorkspace) {
      const guest = await this.deps.vm.guest()
      this.update({ bytesTotal: tarSizeEstimate(await guest.estimateWorkspace(excludes, signal)) })
      let done = 0
      workspace = {
        open: async () =>
          Readable.fromWeb((await guest.workspaceTar(excludes, signal)) as NodeReadableStream),
        excludes,
        onBytes: (n) => {
          done += n
          const total = this.job?.bytesTotal ?? null
          this.update({ bytesDone: done, progress: total ? Math.min(0.99, done / total) : null }, false)
        },
      }
    }
    const result = await writeBackupZip({
      db: this.deps.db,
      path: body.path,
      workspaceName: this.deps.workspaceName(),
      version: this.deps.version,
      now: this.deps.now(),
      ...(workspace ? { workspace } : {}),
      knowledgeDir: join(this.deps.workspaceDir, 'knowledge'),
      skillsDir: join(this.deps.workspaceDir, 'skills'),
      onPhase: (phase) => this.update({ phase }),
    })
    return result.bytes
  }

  private dataDisk(): string {
    return join(this.deps.workspaceDir, 'vm', 'data.qcow2')
  }

  private async runDisk(body: Extract<StartBody, { kind: 'disk' }>, signal: AbortSignal): Promise<number> {
    const { vm } = this.deps
    const source = this.dataDisk()
    const partial = `${body.path}.partial`
    const qemuImg = this.deps.qemuImg() as string
    const wasRunning = vm.processRunning()
    if (wasRunning) {
      this.update({ phase: 'stopping_vm' })
      await vm.stop()
    }
    try {
      this.update({ phase: 'disk', bytesTotal: (await stat(source)).size })
      await this.convert(qemuImg, source, partial, signal)
      if (vm.processRunning())
        throw new Error('The VM was started during the copy, so the copy may be inconsistent. Try again.')
      this.update({ phase: 'finishing' })
      await rename(partial, body.path)
      return (await stat(body.path)).size
    } catch (err) {
      await rm(partial, { force: true })
      throw err
    } finally {
      if (wasRunning)
        void vm
          .start()
          .catch((err: unknown) => this.deps.log('warn', 'vm start after disk copy failed', { err }))
    }
  }

  private convert(qemuImg: string, source: string, target: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(qemuImg, qemuImgConvertArgs(source, target), {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => {
        const progress = parseQemuImgProgress(chunk.toString('utf8'))
        if (progress === null) return
        const total = this.job?.bytesTotal ?? 0
        this.update({ progress: Math.min(0.99, progress), bytesDone: Math.round(total * progress) }, false)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-2000)
      })
      const onAbort = () => child.kill('SIGTERM')
      signal.addEventListener('abort', onAbort, { once: true })
      child.on('error', reject)
      child.on('close', (code) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) reject(new Error('cancelled'))
        else if (code === 0) resolve()
        else reject(new Error(stderr.trim() || `qemu-img exited with ${code}`))
      })
    })
  }

  async estimate(excludes: string[] | undefined): Promise<BackupEstimate> {
    const guest = await this.deps.vm.guest()
    return {
      workspaceBytes: tarSizeEstimate(await guest.estimateWorkspace(excludes ?? DEFAULT_BACKUP_EXCLUDES)),
    }
  }

  restore(): BackupRestore | null {
    return this.deps.getSetting<BackupRestore | null>(BACKUP_RESTORE_KEY, null)
  }

  private saveRestore(patch: Partial<BackupRestore>): BackupRestore {
    const current = this.restore()
    if (!current) throw new DaemonError('not_found', 'This workspace has no backup to restore')
    const next = { ...current, ...patch, updatedAt: this.deps.now() }
    this.deps.setSetting(BACKUP_RESTORE_KEY, next)
    this.deps.emit({ type: 'backup.restore', payload: { restore: next } })
    return next
  }

  /** Runs a pending restore (also one a previous runtime left half done) once the VM runs. */
  private maybeRestore(): void {
    const restore = this.restore()
    if (!restore || (restore.status !== 'pending' && restore.status !== 'running')) return
    if (this.restoring || this.deps.vmPending() || this.deps.vm.status().state !== 'running') return
    this.restoring = this.runRestore()
      .catch((err: unknown) => {
        this.deps.log('error', 'workspace restore failed', { err: errorMessage(err) })
        this.saveRestore({
          status: 'error',
          error: errorMessage(err),
          errorReason: err instanceof RestoreError ? err.reason : null,
        })
      })
      .finally(() => {
        this.restoring = null
        this.restoreAbort = null
      })
  }

  private async runRestore(): Promise<void> {
    const restore = this.saveRestore({ status: 'running', bytesDone: 0, error: null, errorReason: null })
    if (!existsSync(restore.path))
      throw new RestoreError(
        `The backup file is no longer at ${restore.path}. Choose where it is now.`,
        'file_missing',
      )
    const reader = await ZipReader.open(restore.path)
    const entry = reader.entry(WORKSPACE_ENTRY)
    if (!entry) throw new RestoreError('This backup has no /workspace archive', 'no_workspace')
    const controller = new AbortController()
    this.restoreAbort = controller
    let done = 0
    let lastSaved = 0
    const counter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        done += chunk.length
        const at = this.deps.now()
        if (at - lastSaved >= 1000) {
          lastSaved = at
          this.saveRestore({ bytesDone: done, bytesTotal: entry.compressedSize })
        }
        callback(null, chunk)
      },
    })
    const gunzip = createGunzip()
    const decompressing = pipeline(await reader.rawStream(entry), counter, gunzip).catch((err: unknown) =>
      gunzip.destroy(err as Error),
    )
    const guest = this.deps.vm.runningGuest()
    const result = await guest.extractWorkspace(
      Readable.toWeb(gunzip) as unknown as ReadableStream<Uint8Array>,
      controller.signal,
    )
    await decompressing
    if (!result.ok)
      throw new Error(result.stderr.split('\n').slice(-3).join('\n') || `tar exited with ${result.code}`)
    this.saveRestore({ status: 'done', bytesDone: entry.compressedSize, error: null, errorReason: null })
    this.deps.log('info', 'workspace restored from backup', { bytes: entry.compressedSize })
  }

  retryRestore(path: string | undefined): BackupRestore {
    const current = this.restore()
    if (!current) throw new DaemonError('not_found', 'This workspace has no backup to restore')
    if (current.status === 'running' && this.restoring)
      throw new DaemonError('conflict', 'The restore is already running')
    if (path !== undefined && (!isAbsolute(path) || !existsSync(path)))
      throw new DaemonError('validation_failed', `Backup not found: ${path}`, { reason: 'file_missing' })
    const next = this.saveRestore({
      status: 'pending',
      error: null,
      errorReason: null,
      ...(path ? { path } : {}),
    })
    this.maybeRestore()
    return this.restore() ?? next
  }

  skipRestore(): BackupRestore {
    this.restoreAbort?.abort()
    return this.saveRestore({ status: 'skipped', error: null })
  }

  /** Waits for a running restore (tests). */
  async settled(): Promise<void> {
    await this.restoring
  }
}
