import type { LogFn, TaskStatus } from '@milibot/shared'

import { errorMessage } from '../../errors'
import { WORKSPACE_DIR } from '../files'
import { type GuestClient, type VmController, whenVmRunning } from '../vm'
import { type CleanupCandidate, runCleanup } from './cleanup'
import type { WorktreeRow, WorktreeStore } from './store'

const WORKTREES_DIR = `${WORKSPACE_DIR}/worktrees/`
const SWEEP_MS = 60 * 60_000
const DEBOUNCE_MS = 5_000

export interface WorktreeJanitorDeps {
  worktrees: WorktreeStore
  vm: Pick<VmController, 'runningGuest' | 'status' | 'subscribe'>
  /** Whether a session's worktree may go (`WorkSessionService.worktreeDone`). */
  sessionDone(sessionId: string): boolean
  /** A session's worktree was removed (or found gone). */
  sessionWorktreeRemoved(sessionId: string): void
  /** Status of the newest pull request of a branch in a repository; null when none is known. */
  pullRequestStatus(repoName: string, branch: string): TaskStatus | null
  /** Whether a turn of the lane is running or queued. */
  laneBusy(laneKey: string): boolean
  sweepMs?: number
  debounceMs?: number
  log?: LogFn
}

interface ListedWorktree {
  /** '' = detached HEAD. */
  branch: string
}

/** `git worktree list --porcelain`: the worktrees that exist, by path; null when the output is not one. */
function parseWorktreeList(stdout: string, mainPath: string): Map<string, ListedWorktree> | null {
  const out = new Map<string, ListedWorktree>()
  for (const block of stdout.split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim())
    const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length)
    if (!path || lines.some((l) => l === 'prunable' || l.startsWith('prunable '))) continue
    const ref = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length) ?? ''
    out.set(path, { branch: ref.replace(/^refs\/heads\//, '') })
  }
  return out.has(mainPath) ? out : null
}

const ended = (status: TaskStatus | null) => status === 'done' || status === 'failed'

/**
 * Removes the worktrees of finished work (`scripts/cleanup.sh` decides, by their content, whether anything
 * would be lost): a session's once it ended and its patches are saved, a chat one once its branch's pull
 * request was merged or closed. Runs when kicked (a session ended, a pull request closed), when the VM comes
 * up and every hour; one run at a time, never booting the VM. Only rows of the registry under
 * /workspace/worktrees are touched: worktrees made by hand are not Milibot's.
 */
export class WorktreeJanitor {
  private interval: NodeJS.Timeout | null = null
  private debounce: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private again = false
  private unsubscribe = () => {}

  constructor(private readonly deps: WorktreeJanitorDeps) {}

  start(): void {
    this.interval = setInterval(() => this.kick(), this.deps.sweepMs ?? SWEEP_MS)
    this.interval.unref()
    this.unsubscribe = whenVmRunning(this.deps.vm, () => this.kick())
  }

  async stop(): Promise<void> {
    this.unsubscribe()
    if (this.interval) clearInterval(this.interval)
    if (this.debounce) clearTimeout(this.debounce)
    this.interval = this.debounce = null
    this.again = false
    await this.running
  }

  /** A run soon (kicks close together make one). */
  kick(): void {
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = null
      void this.run()
    }, this.deps.debounceMs ?? DEBOUNCE_MS)
    this.debounce.unref()
  }

  /** One pass; one asked for while another runs follows it. */
  run(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = this.sweep()
      .catch((err: unknown) => this.deps.log?.('warn', 'worktree cleanup failed', { err: errorMessage(err) }))
      .finally(() => {
        this.running = null
        if (this.again) {
          this.again = false
          void this.run()
        }
      })
    return this.running
  }

  private async sweep(): Promise<void> {
    let guest: GuestClient
    try {
      guest = this.deps.vm.runningGuest()
    } catch {
      return
    }
    const byRepo = new Map<string, WorktreeRow[]>()
    for (const row of this.deps.worktrees.listActive()) {
      if (!row.worktreePath.startsWith(WORKTREES_DIR)) continue
      byRepo.set(row.repoName, [...(byRepo.get(row.repoName) ?? []), row])
    }
    for (const [repoName, rows] of byRepo) {
      try {
        await this.sweepRepo(guest, repoName, rows)
      } catch (err) {
        this.deps.log?.('warn', 'worktree cleanup failed', { repo: repoName, err: errorMessage(err) })
      }
    }
  }

  private released(row: WorktreeRow, branch?: string): void {
    this.deps.worktrees.release(row.id, branch ? { branch } : {})
    if (row.sessionId) this.deps.sessionWorktreeRemoved(row.sessionId)
  }

  /** Rows of worktrees that no longer exist are released, and each row follows the branch checked out. */
  private async reconcile(guest: GuestClient, repoName: string, rows: WorktreeRow[]): Promise<WorktreeRow[]> {
    const mainPath = `${WORKSPACE_DIR}/repos/${repoName}`
    const result = await guest.exec({
      cmd: 'git -c safe.directory="*" -C "$REPO_DIR" worktree list --porcelain',
      env: { REPO_DIR: mainPath },
      timeoutMs: 30_000,
    })
    const listed = result.code === 0 ? parseWorktreeList(result.stdout, mainPath) : null
    if (!listed) return rows
    const present: WorktreeRow[] = []
    for (const row of rows) {
      const found = listed.get(row.worktreePath)
      if (!found) {
        this.released(row)
        continue
      }
      if (found.branch && found.branch !== row.branch) {
        this.deps.worktrees.setBranch(row.id, found.branch)
        present.push({ ...row, branch: found.branch })
      } else present.push(row)
    }
    return present
  }

  private async sweepRepo(guest: GuestClient, repoName: string, all: WorktreeRow[]): Promise<void> {
    const rows = await this.reconcile(guest, repoName, all)
    const candidates = new Map<string, { row: WorktreeRow; candidate: CleanupCandidate }>()
    for (const row of rows) {
      const prDone = ended(this.deps.pullRequestStatus(repoName, row.branch))
      const done = row.sessionId
        ? this.deps.sessionDone(row.sessionId)
        : prDone && !this.deps.laneBusy(row.botId)
      if (done)
        candidates.set(row.worktreePath, {
          row,
          candidate: { path: row.worktreePath, branch: row.branch, prDone },
        })
    }
    if (!candidates.size) return
    const { fetchFailed, results } = await runCleanup(guest, {
      repoName,
      baseBranch: '',
      candidates: [...candidates.values()].map((c) => c.candidate),
    })
    const removed: string[] = []
    const kept: string[] = []
    for (const result of results) {
      const entry = candidates.get(result.path)
      if (!entry) continue
      if (result.outcome === 'kept') {
        kept.push(`${result.path} (${result.reason})`)
        continue
      }
      this.released(entry.row, result.branch)
      if (result.outcome === 'removed') removed.push(result.path)
    }
    if (removed.length)
      this.deps.log?.('info', 'worktrees removed', { repo: repoName, removed, kept, fetchFailed })
  }
}
