import type { ExecResult, LogFn, TaskStatus } from '@milibot/shared'

import { errorMessage } from '../../errors'
import { statusOfPr } from './pr-detect'

/** A GitHub pull request named by its URL; `key` (the canonical URL, lowercased) identifies it. */
export interface PullRequestRef {
  key: string
  owner: string
  name: string
  number: number
}

const PR_URL = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#]|$)/i

export function pullRequestRef(url: string | null | undefined): PullRequestRef | null {
  const match = url ? PR_URL.exec(url.trim()) : null
  if (!match) return null
  const [, owner, name, number] = match as unknown as [string, string, string, string]
  return {
    key: `https://github.com/${owner}/${name}/pull/${number}`.toLowerCase(),
    owner,
    name,
    number: Number(number),
  }
}

export function pullRequestKey(url: string | null | undefined): string | null {
  return pullRequestRef(url)?.key ?? null
}

/** Pull requests asked about in one GraphQL query (GitHub limits a query's nodes). */
const QUERY_SIZE = 50
/** Pull requests watched at most, newest first. */
const MAX_TRACKED = 150
const POLL_MS = 60_000

/** One GraphQL query asking the state of every pull request, aliased `r<repo>`/`p<pr>`. */
export function pullRequestQuery(refs: PullRequestRef[]): {
  query: string
  aliases: Map<string, string>
} {
  const repos = new Map<string, PullRequestRef[]>()
  for (const ref of refs) {
    const repo = `${ref.owner}/${ref.name}`.toLowerCase()
    repos.set(repo, [...(repos.get(repo) ?? []), ref])
  }
  const aliases = new Map<string, string>()
  let pr = 0
  const parts = [...repos.values()].map((list, r) => {
    const first = list[0] as PullRequestRef
    const fields = list.map((ref) => {
      const alias = `p${pr++}`
      aliases.set(`r${r}.${alias}`, ref.key)
      return `${alias}: pullRequest(number: ${ref.number}) { state isDraft }`
    })
    return `r${r}: repository(owner: "${first.owner}", name: "${first.name}") { ${fields.join(' ')} }`
  })
  return { query: `query { ${parts.join(' ')} }`, aliases }
}

/** The status of each pull request the response answers; those it does not (no access, deleted) are left out. */
export function parsePullRequestStatuses(
  response: unknown,
  aliases: Map<string, string>,
): Map<string, TaskStatus> {
  const out = new Map<string, TaskStatus>()
  const data = (response as { data?: unknown } | null)?.data
  if (!data || typeof data !== 'object') return out
  for (const [path, key] of aliases) {
    const [repo, pr] = path.split('.') as [string, string]
    const node = ((data as Record<string, unknown>)[repo] as Record<string, unknown> | null | undefined)?.[
      pr
    ] as { state?: unknown; isDraft?: unknown } | null | undefined
    if (!node || (node.state !== 'OPEN' && node.state !== 'CLOSED' && node.state !== 'MERGED')) continue
    out.set(key, statusOfPr({ state: node.state, isDraft: node.isDraft === true }))
  }
  return out
}

export interface GithubGraphqlDeps {
  /** The workspace's GitHub token; null when none is set. */
  token(): Promise<string | null>
  fetch: typeof fetch
  /** GitHub API base, e.g. `https://api.github.com`. */
  api: string
  /** `gh` in the VM as a bot, for a login made there without the workspace token; null when the VM is down. */
  ghExec(cmd: string, env: Record<string, string>): Promise<ExecResult | null>
}

/**
 * Asks GitHub's GraphQL API: from the daemon with the workspace token, else through `gh` in the VM.
 * Null when neither can answer.
 */
export async function githubGraphql(deps: GithubGraphqlDeps, query: string): Promise<unknown> {
  const token = await deps.token()
  if (token) {
    const res = await deps.fetch(`${deps.api}/graphql`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
    return (await res.json()) as unknown
  }
  // A query with errors (a PR gone or out of reach) makes gh exit 1, still printing the data it got.
  const result = await deps.ghExec('gh api graphql -f query="$PR_QUERY"', {
    PR_QUERY: query,
    GH_PROMPT_DISABLED: '1',
  })
  if (!result?.stdout.trim()) return null
  try {
    return JSON.parse(result.stdout) as unknown
  } catch {
    return null
  }
}

export interface PullRequestStatusDeps {
  /** URLs of the pull requests shown with a status that can still change (not merged), newest first. */
  tracked(): string[]
  /** Runs a GraphQL query on GitHub; null (or a throw) when GitHub cannot be asked. */
  graphql(query: string): Promise<unknown>
  /** Statuses read from GitHub, by `PullRequestRef.key`. */
  apply(statuses: Map<string, TaskStatus>): void
  pollMs?: number
  log?: LogFn
}

/**
 * Keeps the status of the pull requests shown in chat cards and board links current, also for merges
 * and closes made outside Milibot: polls GitHub while any of them can still change. A failed poll
 * changes nothing (the last status seen stays).
 */
export class PullRequestStatusWatcher {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private failing = false

  constructor(private readonly deps: PullRequestStatusDeps) {}

  start(): void {
    this.timer = setInterval(() => void this.refresh(), this.deps.pollMs ?? POLL_MS)
    this.timer.unref()
    void this.refresh()
  }

  stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    return this.running ?? Promise.resolve()
  }

  /** One poll; a poll already running is joined instead of starting another. */
  refresh(): Promise<void> {
    this.running ??= this.poll().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async poll(): Promise<void> {
    const refs = new Map<string, PullRequestRef>()
    for (const url of this.deps.tracked()) {
      const ref = pullRequestRef(url)
      if (ref && !refs.has(ref.key)) refs.set(ref.key, ref)
      if (refs.size >= MAX_TRACKED) break
    }
    const all = [...refs.values()]
    for (let i = 0; i < all.length; i += QUERY_SIZE) {
      const { query, aliases } = pullRequestQuery(all.slice(i, i + QUERY_SIZE))
      let statuses: Map<string, TaskStatus>
      try {
        statuses = parsePullRequestStatuses(await this.deps.graphql(query), aliases)
        if (this.failing) this.deps.log?.('info', 'pull request status check works again')
        this.failing = false
      } catch (err) {
        if (!this.failing)
          this.deps.log?.('warn', 'pull request status check failed', { err: errorMessage(err) })
        this.failing = true
        return
      }
      try {
        if (statuses.size) this.deps.apply(statuses)
      } catch (err) {
        this.deps.log?.('warn', 'pull request status update failed', { err: errorMessage(err) })
      }
    }
  }
}
