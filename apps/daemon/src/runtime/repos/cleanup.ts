import type { GuestClient } from '../vm'
import { CLEANUP_SCRIPT } from './scripts/cleanup.generated'

export interface CleanupCandidate {
  path: string
  /** The branch the registry knows it by. */
  branch: string
  /** Its pull request was merged or closed: its branch may be deleted too. */
  prDone: boolean
}

export interface CleanupResult {
  path: string
  outcome: 'removed' | 'gone' | 'kept'
  /** Why it was kept (`dirty`, `unpushed`, `fetch_failed`…). */
  reason: string | null
  /** The branch checked out in it ('' = detached HEAD or unknown). */
  branch: string
  branchDeleted: boolean
}

/** The script's stdin: one `<path>|<branch>|<policy>` line per candidate. */
export function cleanupInput(candidates: readonly CleanupCandidate[]): string {
  return candidates.map((c) => `${c.path}|${c.branch}|${c.prDone ? 'pr_done' : '-'}\n`).join('')
}

export function parseCleanupOutput(stdout: string): { fetchFailed: boolean; results: CleanupResult[] } {
  const results: CleanupResult[] = []
  let fetchFailed = false
  for (const line of stdout.split('\n')) {
    if (line.trim() === 'FETCH=failed') fetchFailed = true
    if (!line.startsWith('RESULT=')) continue
    const [path = '', status = '', branch = '', deleted = '0'] = line.slice('RESULT='.length).split('|')
    const kept = status.startsWith('kept:')
    if (!path || (!kept && status !== 'removed' && status !== 'gone')) continue
    results.push({
      path,
      outcome: kept ? 'kept' : (status as 'removed' | 'gone'),
      reason: kept ? status.slice('kept:'.length) : null,
      branch,
      branchDeleted: deleted === '1',
    })
  }
  return { fetchFailed, results }
}

/** Runs `CLEANUP_SCRIPT` as `agent` (who can remove what every bot and its tools wrote) on one repository. */
export async function runCleanup(
  guest: Pick<GuestClient, 'exec'>,
  input: { repoName: string; baseBranch: string; candidates: readonly CleanupCandidate[] },
): Promise<{ fetchFailed: boolean; results: CleanupResult[] }> {
  const result = await guest.exec({
    user: 'agent',
    cmd: CLEANUP_SCRIPT,
    cwd: '/workspace',
    stdin: cleanupInput(input.candidates),
    env: { REPO_NAME: input.repoName, BASE_BRANCH: input.baseBranch, GIT_TERMINAL_PROMPT: '0' },
    timeoutMs: 600_000,
  })
  if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().slice(0, 500) || 'cleanup failed')
  return parseCleanupOutput(result.stdout)
}
