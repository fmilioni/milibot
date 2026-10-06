import {
  type Bot,
  isPreviewableImagePath,
  type LogFn,
  type SessionChangedFile,
  type SessionChanges,
  type SessionChangeTotals,
  type SessionFileDiff,
  type SessionFileImages,
  type SessionImage,
  type WorkspaceEvent,
} from '@milibot/shared'

import { parseJson } from '../../db/sqlite'
import { DaemonError, errorMessage, notFound } from '../../errors'
import { imageMediaType } from '../files'
import type { GuestClient, VmController } from '../vm'
import {
  changeTotals,
  cutPatch,
  DIFF_SCRIPT_ENV,
  DIFF_SCRIPTS,
  FILE_CHANGING_TOOLS,
  type ImageSide,
  languageOf,
  MAX_IMAGE_BYTES,
  MAX_PATCH_BYTES,
  MAX_SAVED_PATCHES_BYTES,
  parseAllPatches,
  parseBaseline,
  parseChanges,
  parseImageSides,
  parseSavedTree,
  type SavedTree,
  SHADOW_MAX_FILES,
  SHADOW_MAX_KB,
  shadowGitDir,
  STORED_FILES,
} from './diff'
import { isFinished, type SessionRow, type SessionStore } from './store'

const CHANGES_DEBOUNCE_MS = 1500
const GIT_TIMEOUT_MS = 30_000
const GIT_OUTPUT_BYTES = 8 * 1024 * 1024
/** Both sides of an image in base64, with room for the size lines. */
const IMAGE_OUTPUT_BYTES = Math.ceil((MAX_IMAGE_BYTES * 2 * 4) / 3) + 1024

export interface StoredChanges {
  totals: SessionChangeTotals
  files: SessionChangedFile[]
  computedAt: number
}

/** The last changes saved on the row (what cards and lists show without the VM). */
export function storedChanges(row: SessionRow): StoredChanges | null {
  return parseJson<StoredChanges | null>(row.changes_json, null)
}

function sessionImage(side: ImageSide | null): SessionImage | null {
  if (!side) return null
  if (!side.data) return { bytes: side.bytes }
  const mediaType = imageMediaType(side.data)
  return mediaType ? { bytes: side.bytes, mediaType, data: side.data.toString('base64') } : null
}

export interface SessionChangesDeps {
  store: SessionStore
  vm: Pick<VmController, 'runningGuest'>
  bot: (id: string) => Bot | null
  emit: (event: WorkspaceEvent) => void
  /** The saved totals of a session changed. */
  onSaved: (row: SessionRow) => void
  now: () => number
  log?: LogFn
}

/**
 * What a work session changed in its folder, measured in the VM against a baseline (the commit the folder was
 * on, or a shadow repository of a folder without git) with a temporary index, never touching the real one.
 */
export class SessionChangesTracker {
  /** Changes computed since the last file change (dropped when a tool may have changed files). */
  private readonly cache = new Map<string, SessionChanges>()
  private readonly inFlight = new Map<string, Promise<SessionChanges>>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  /** Running tool calls of session lanes that may change files → their session. */
  private readonly fileTools = new Map<string, string>()
  private stopped = false

  constructor(private readonly deps: SessionChangesDeps) {}

  start(): void {
    this.stopped = false
  }

  stop(): void {
    this.stopped = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /** The session was deleted. */
  forget(id: string): void {
    this.cache.delete(id)
    const timer = this.timers.get(id)
    if (timer) clearTimeout(timer)
    this.timers.delete(id)
  }

  private async git(
    row: SessionRow,
    guest: GuestClient,
    script: string,
    env: Record<string, string>,
    maxOutputBytes = GIT_OUTPUT_BYTES,
  ): Promise<string> {
    const bot = this.deps.bot(row.bot_id)
    const result = await guest.exec({
      ...(bot ? { user: `bot-${bot.slug}`, bot: bot.slug } : {}),
      cmd: script,
      cwd: '/workspace',
      env: {
        ...DIFF_SCRIPT_ENV,
        SESSION_CWD: row.cwd ?? '/workspace',
        SHADOW_DIR: shadowGitDir(row.id),
        ...env,
      },
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes,
    })
    if (result.code !== 0)
      throw new Error((result.stderr || result.stdout).trim().slice(0, 500) || 'git failed')
    return result.stdout
  }

  /**
   * Where the session's changes are measured from: the commit its folder is on, or a snapshot of a folder
   * without git. A baseline taken late (the VM was off when the session started) misses what changed before.
   */
  async takeBaseline(row: SessionRow, bot: Bot, guest: GuestClient): Promise<SessionRow> {
    if (row.base_commit || row.baseline_error || !row.cwd) return row
    const stdout = await this.git(row, guest, DIFF_SCRIPTS.baseline, {
      MODE: 'git',
      MAX_FILES: String(SHADOW_MAX_FILES),
      MAX_KB: String(SHADOW_MAX_KB),
    })
    const baseline = parseBaseline(stdout)
    if ('error' in baseline) {
      if (baseline.error === 'too_large')
        return this.deps.store.update(row.id, { baseline_error: 'too_large' })
      throw new Error(`unexpected baseline output for ${bot.slug}: ${stdout.slice(0, 200)}`)
    }
    return this.deps.store.update(row.id, {
      base_commit: baseline.base,
      shadow_git: baseline.mode === 'shadow' ? shadowGitDir(row.id) : null,
    })
  }

  private unavailable(reason: SessionChanges['reason'], base: string | null = null): SessionChanges {
    return {
      available: false,
      reason,
      base,
      files: [],
      totals: { files: 0, additions: 0, deletions: 0 },
      computedAt: this.deps.now(),
    }
  }

  private changeEnv(row: SessionRow, file: { path: string; oldPath?: string } | null) {
    return {
      MODE: row.shadow_git ? 'shadow' : 'git',
      BASE: row.base_commit ?? '',
      FILE_PATH: file?.path ?? '',
      OLD_PATH: file?.oldPath ?? '',
      MAX_PATCH: String(MAX_PATCH_BYTES + 1),
    }
  }

  private async compute(id: string): Promise<SessionChanges> {
    let row = this.deps.store.requireRow(id)
    if (row.baseline_error === 'too_large') return this.unavailable('too_large')
    if (!row.cwd) return this.unavailable('no_baseline')
    let guest: GuestClient
    try {
      guest = this.deps.vm.runningGuest()
    } catch {
      return this.unavailable('vm_not_running', row.base_commit)
    }
    const bot = this.deps.bot(row.bot_id)
    try {
      if (!row.base_commit && bot) row = await this.takeBaseline(row, bot, guest)
      if (row.baseline_error === 'too_large') return this.unavailable('too_large')
      if (!row.base_commit) return this.unavailable('no_baseline')
      const files = parseChanges(await this.git(row, guest, DIFF_SCRIPTS.changes, this.changeEnv(row, null)))
      return {
        available: true,
        base: row.base_commit,
        files,
        totals: changeTotals(files),
        computedAt: this.deps.now(),
      }
    } catch (err) {
      this.deps.log?.('warn', 'work session changes failed', { sessionId: id, err: errorMessage(err) })
      return this.unavailable('failed', row.base_commit)
    }
  }

  /**
   * The session's changes: the ones saved when it finished, else measured (again only after a tool may have
   * changed files).
   */
  changes(id: string): Promise<SessionChanges> {
    const saved = this.savedChanges(this.deps.store.requireRow(id))
    return saved ? Promise.resolve(saved) : this.liveChanges(id)
  }

  private savedChanges(row: SessionRow): SessionChanges | null {
    if (!isFinished(row.status) || row.patches_at === null) return null
    const stored = storedChanges(row)
    if (!stored) return null
    return { available: true, base: row.base_commit, ...stored }
  }

  private liveChanges(id: string): Promise<SessionChanges> {
    const cached = this.cache.get(id)
    if (cached) return Promise.resolve(cached)
    const running = this.inFlight.get(id)
    if (running) return running
    const task = this.compute(id)
      .then((changes) => {
        if (changes.available && this.inFlight.get(id) === task) this.cache.set(id, changes)
        return changes
      })
      .finally(() => {
        if (this.inFlight.get(id) === task) this.inFlight.delete(id)
      })
    this.inFlight.set(id, task)
    return task
  }

  private async changedFile(id: string, path: string): Promise<SessionChangedFile> {
    const changes = await this.changes(id)
    const file = changes.files.find((f) => f.path === path)
    if (!file) throw notFound('changed file', path)
    return file
  }

  private guestForDiff(): GuestClient {
    try {
      return this.deps.vm.runningGuest()
    } catch {
      throw new DaemonError('conflict', 'The workspace VM is not running', { reason: 'vm_not_running' })
    }
  }

  async fileDiff(id: string, path: string): Promise<SessionFileDiff> {
    const file = await this.changedFile(id, path)
    const base = {
      path: file.path,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      status: file.status,
      binary: file.binary,
      ...(languageOf(file.path) ? { language: languageOf(file.path) } : {}),
    }
    if (file.binary) return { ...base, patch: '', truncated: false }
    const row = this.deps.store.requireRow(id)
    const saved = this.savedChanges(row) ? this.deps.store.savedPatch(id, file.path) : null
    if (saved) return { ...base, patch: saved.patch, truncated: saved.truncated }
    const patch = await this.git(row, this.guestForDiff(), DIFF_SCRIPTS.changes, this.changeEnv(row, file))
    return { ...base, ...cutPatch(patch) }
  }

  /**
   * A changed image at the baseline and now, to show instead of a binary diff. Once the folder is gone (its
   * worktree was cleaned up) both sides come from the tree saved with the patches; `unavailable` when they can't.
   */
  async fileImages(id: string, path: string): Promise<SessionFileImages> {
    const file = await this.changedFile(id, path)
    if (!isPreviewableImagePath(file.path)) throw notFound('changed image', path)
    const row = this.deps.store.requireRow(id)
    const saved = this.savedChanges(row) ? parseJson<SavedTree | null>(row.patches_tree, null) : null
    const stdout = await this.git(
      row,
      this.guestForDiff(),
      DIFF_SCRIPTS.image,
      {
        ...this.changeEnv(row, null),
        BEFORE_PATH: file.status === 'added' ? '' : (file.oldPath ?? file.path),
        AFTER_PATH: file.status === 'deleted' ? '' : file.path,
        MAX_IMAGE: String(MAX_IMAGE_BYTES),
        ...(saved ? { SAVED_TREE: saved.tree, SAVED_GIT_DIR: saved.gitDir, SAVED_PREFIX: saved.prefix } : {}),
      },
      IMAGE_OUTPUT_BYTES,
    )
    if (stdout.trim() === 'GONE') return { before: null, after: null, unavailable: true }
    const sides = parseImageSides(stdout)
    return { before: sessionImage(sides.before), after: sessionImage(sides.after) }
  }

  /** Files may have changed: the next read computes again, and the totals follow shortly. */
  markChanged(id: string, delayMs = CHANGES_DEBOUNCE_MS): void {
    if (this.stopped) return
    this.cache.delete(id)
    this.inFlight.delete(id)
    const previous = this.timers.get(id)
    if (previous) clearTimeout(previous)
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id)
        void this.refresh(id)
      }, delayMs),
    )
  }

  private async refresh(id: string): Promise<void> {
    if (!this.deps.store.row(id)) return
    try {
      this.deps.vm.runningGuest()
    } catch {
      return
    }
    const changes = await this.liveChanges(id)
    if (this.stopped || !changes.available) return
    if (!this.deps.store.row(id)) return
    const stored: StoredChanges = {
      totals: changes.totals,
      files: changes.files.slice(0, STORED_FILES),
      computedAt: changes.computedAt,
    }
    const next = this.deps.store.update(id, { changes_json: JSON.stringify(stored) })
    if (isFinished(next.status)) await this.savePatches(next)
    this.deps.emit({ type: 'work_session.files_changed', payload: { sessionId: id, totals: changes.totals } })
    this.deps.onSaved(next)
  }

  /** The patch of every file of a session that finished, kept for when the VM or the folder is gone. */
  private async savePatches(row: SessionRow): Promise<void> {
    try {
      const stdout = await this.git(row, this.deps.vm.runningGuest(), DIFF_SCRIPTS.changes, {
        ...this.changeEnv(row, null),
        ALL_PATCHES: '1',
        MAX_TOTAL: String(MAX_SAVED_PATCHES_BYTES),
      })
      if (this.stopped || !this.deps.store.row(row.id)) return
      this.deps.store.savePatches(
        row.id,
        parseAllPatches(stdout, MAX_SAVED_PATCHES_BYTES),
        parseSavedTree(stdout),
      )
    } catch (err) {
      this.deps.log?.('warn', 'work session patches not saved', { sessionId: row.id, err: errorMessage(err) })
    }
  }

  async removeShadow(row: SessionRow): Promise<void> {
    try {
      const guest = this.deps.vm.runningGuest()
      await guest.exec({
        cmd: 'rm -rf -- "$SHADOW_DIR"',
        user: 'root',
        env: { SHADOW_DIR: row.shadow_git as string },
        timeoutMs: GIT_TIMEOUT_MS,
      })
    } catch (err) {
      this.deps.log?.('warn', 'work session snapshot not removed', {
        sessionId: row.id,
        err: errorMessage(err),
      })
    }
  }

  /** A tool started (`startToolCall`): remember it when it may change files in a session's folder. */
  onToolStarted(record: { id: string; toolName: string; conversationId: string | null }): void {
    if (!FILE_CHANGING_TOOLS.has(record.toolName) || !record.conversationId) return
    const row = this.deps.store.byConversation(record.conversationId)
    if (row && !isFinished(row.status)) this.fileTools.set(record.id, row.id)
  }

  onToolFinished(id: string): void {
    const sessionId = this.fileTools.get(id)
    if (!sessionId) return
    this.fileTools.delete(id)
    this.markChanged(sessionId)
  }
}
