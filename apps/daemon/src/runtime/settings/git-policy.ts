import type { LogFn } from '@milibot/shared'

import { errorMessage } from '../../errors'
import { onVmTransition, type VmController } from '../vm'
import { SYNC_GIT_POLICY_SCRIPT } from './scripts/sync-git-policy.generated'

export interface GitPolicy {
  draftPrs: boolean
  autoMerge: boolean
  /** Folders of work sessions whose plan allows merging (`gh pr merge` run inside them is let through). */
  allowMergeDirs: string[]
}

/** Contents of `/etc/milibot/git-policy`, read by the `gh` wrapper. */
export function gitPolicyFile(policy: GitPolicy): string {
  const dirs = [...new Set(policy.allowMergeDirs.filter(isSessionDir))].sort()
  return [
    `DRAFT_PRS=${policy.draftPrs ? 1 : 0}`,
    `AUTO_MERGE=${policy.autoMerge ? 1 : 0}`,
    ...dirs.map((dir) => `ALLOW_MERGE_DIR=${dir}`),
    '',
  ].join('\n')
}

/** Only a folder inside /workspace (never /workspace itself, which holds every repository). */
function isSessionDir(dir: string): boolean {
  return /^\/workspace\/[^\n]+$/.test(dir) && !dir.split('/').includes('..')
}

export interface GitPolicySyncDeps {
  vm: Pick<VmController, 'status' | 'subscribe' | 'runningGuest'>
  preferences: () => { draftPrs: boolean; autoMergePrs: boolean }
  /** Folders of the open work sessions whose plan allows merging. */
  mergePrFolders: () => string[]
  debounceMs?: number
  log: LogFn
}

/**
 * Keeps the policy file of the VM's `gh` wrapper (installed by the guest agent) in line with the PR preferences
 * and the work sessions allowed to merge. A guard against mistakes (a CLI engine's own shell never passes
 * through the daemon), not security: `/usr/bin/gh` is still there.
 */
export class GitPolicySync {
  private written: string | null = null
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private again = false
  private unsubscribe: (() => void) | null = null

  constructor(private readonly deps: GitPolicySyncDeps) {}

  start(): void {
    this.unsubscribe = onVmTransition(this.deps.vm, {
      up: () => this.refresh(0),
      down: () => {
        this.written = null
      },
    })
  }

  private policy(): GitPolicy {
    const { draftPrs, autoMergePrs } = this.deps.preferences()
    return {
      draftPrs,
      autoMerge: autoMergePrs,
      allowMergeDirs: autoMergePrs ? [] : this.deps.mergePrFolders(),
    }
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Something the policy depends on may have changed: writes it (debounced) when it did. */
  refresh(delayMs = this.deps.debounceMs ?? 300): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.sync()
    }, delayMs)
    this.timer.unref?.()
  }

  async sync(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = this.write().finally(() => {
      this.running = null
      if (this.again) {
        this.again = false
        void this.sync()
      }
    })
    return this.running
  }

  private async write(): Promise<void> {
    if (this.deps.vm.status().state !== 'running') return
    const policy = gitPolicyFile(this.policy())
    if (policy === this.written) return
    try {
      const result = await this.deps.vm.runningGuest().exec({
        user: 'root',
        cmd: SYNC_GIT_POLICY_SCRIPT,
        cwd: '/',
        env: { POLICY: policy },
        timeoutMs: 20_000,
      })
      if (result.code !== 0) throw new Error(result.stderr.trim() || `exit code ${result.code}`)
      this.written = policy
    } catch (err) {
      this.deps.log('warn', 'could not update the git policy in the VM', { err: errorMessage(err) })
    }
  }
}
