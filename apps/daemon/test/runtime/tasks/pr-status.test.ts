import type { ExecResult, TaskStatus } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import {
  githubGraphql,
  parsePullRequestStatuses,
  pullRequestQuery,
  pullRequestRef,
  PullRequestStatusWatcher,
} from '../../../src/runtime/tasks/pr-status'

const exec = (stdout: string, code = 0): ExecResult => ({
  code,
  signal: null,
  stdout,
  stderr: '',
  truncated: { stdout: false, stderr: false },
  timedOut: false,
  durationMs: 1,
})

describe('pullRequestRef', () => {
  it('reads GitHub pull request URLs into one key, whatever the case or suffix', () => {
    expect(pullRequestRef('https://github.com/Acme/app.js/pull/18/files')).toEqual({
      key: 'https://github.com/acme/app.js/pull/18',
      owner: 'Acme',
      name: 'app.js',
      number: 18,
    })
    expect(pullRequestRef('https://www.github.com/acme/app/pull/18#discussion')?.key).toBe(
      'https://github.com/acme/app/pull/18',
    )
    expect(pullRequestRef('https://github.com/acme/app/issues/18')).toBeNull()
    expect(pullRequestRef('https://gitlab.com/acme/app/pull/18')).toBeNull()
    expect(pullRequestRef('https://github.com/acme/app/pull/18x')).toBeNull()
    expect(pullRequestRef(null)).toBeNull()
  })
})

describe('pullRequestQuery and parsePullRequestStatuses', () => {
  const refs = [
    'https://github.com/acme/app/pull/17',
    'https://github.com/acme/app/pull/18',
    'https://github.com/acme/lib/pull/3',
    'https://github.com/acme/lib/pull/4',
  ].map((url) => pullRequestRef(url)!)

  it('asks every pull request in one query, grouped by repository', () => {
    const { query, aliases } = pullRequestQuery(refs)
    expect(query).toBe(
      'query { r0: repository(owner: "acme", name: "app") { p0: pullRequest(number: 17) { state isDraft } ' +
        'p1: pullRequest(number: 18) { state isDraft } } r1: repository(owner: "acme", name: "lib") { ' +
        'p2: pullRequest(number: 3) { state isDraft } p3: pullRequest(number: 4) { state isDraft } } }',
    )
    expect(aliases.get('r1.p2')).toBe('https://github.com/acme/lib/pull/3')
  })

  it('maps the states it gets and leaves out the pull requests GitHub did not answer', () => {
    const { aliases } = pullRequestQuery(refs)
    const statuses = parsePullRequestStatuses(
      {
        data: {
          r0: { p0: { state: 'MERGED', isDraft: false }, p1: { state: 'OPEN', isDraft: true } },
          r1: { p2: { state: 'CLOSED', isDraft: false }, p3: null },
        },
        errors: [{ type: 'NOT_FOUND' }],
      },
      aliases,
    )
    expect(Object.fromEntries(statuses)).toEqual({
      'https://github.com/acme/app/pull/17': 'done',
      'https://github.com/acme/app/pull/18': 'open',
      'https://github.com/acme/lib/pull/3': 'failed',
    })
    expect(parsePullRequestStatuses({ data: { r0: null } }, aliases).size).toBe(0)
    expect(parsePullRequestStatuses(null, aliases).size).toBe(0)
    expect(parsePullRequestStatuses({ message: 'Bad credentials' }, aliases).size).toBe(0)
  })
})

describe('githubGraphql', () => {
  it('asks the GitHub API with the workspace token, never through the VM', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = []
    const ghCalls: string[] = []
    const answer = await githubGraphql(
      {
        token: async () => 'ghp_secret',
        fetch: (async (url: string, init?: RequestInit) => {
          requests.push({ url, init })
          return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 })
        }) as typeof fetch,
        api: 'http://github.test',
        ghExec: async (cmd) => {
          ghCalls.push(cmd)
          return null
        },
      },
      'query { viewer { login } }',
    )
    expect(answer).toEqual({ data: { ok: true } })
    expect(requests[0]?.url).toBe('http://github.test/graphql')
    expect((requests[0]?.init?.headers as Record<string, string>).authorization).toBe('Bearer ghp_secret')
    expect(JSON.parse(requests[0]?.init?.body as string)).toEqual({ query: 'query { viewer { login } }' })
    expect(ghCalls).toEqual([])
  })

  it('throws when GitHub refuses, so the last status seen stays', async () => {
    await expect(
      githubGraphql(
        {
          token: async () => 'ghp_secret',
          fetch: (async () => new Response('{}', { status: 502 })) as unknown as typeof fetch,
          api: 'http://github.test',
          ghExec: async () => null,
        },
        'query {}',
      ),
    ).rejects.toThrow(/502/)
  })

  it('falls back to gh in the VM without a token, reading the data even when gh exits with errors', async () => {
    const calls: Array<{ cmd: string; env: Record<string, string> }> = []
    const deps = (result: ExecResult | null) => ({
      token: async () => null,
      fetch: (async () => {
        throw new Error('no network expected')
      }) as unknown as typeof fetch,
      api: 'http://github.test',
      ghExec: async (cmd: string, env: Record<string, string>) => {
        calls.push({ cmd, env })
        return result
      },
    })
    expect(await githubGraphql(deps(exec('{"data":{"r0":null}}', 1)), 'query { x }')).toEqual({
      data: { r0: null },
    })
    expect(calls[0]).toEqual({
      cmd: 'gh api graphql -f query="$PR_QUERY"',
      env: { PR_QUERY: 'query { x }', GH_PROMPT_DISABLED: '1' },
    })
    expect(await githubGraphql(deps(null), 'query { x }')).toBeNull()
    expect(await githubGraphql(deps(exec('', 4)), 'query { x }')).toBeNull()
    expect(await githubGraphql(deps(exec('not json', 1)), 'query { x }')).toBeNull()
  })
})

describe('PullRequestStatusWatcher', () => {
  function watcher(answer: (query: string) => Promise<unknown>, tracked: string[]) {
    const applied: Array<Record<string, TaskStatus>> = []
    const queries: string[] = []
    const logs: string[] = []
    const w = new PullRequestStatusWatcher({
      tracked: () => tracked,
      graphql: (query) => {
        queries.push(query)
        return answer(query)
      },
      apply: (statuses) => applied.push(Object.fromEntries(statuses)),
      log: (level, message) => logs.push(`${level} ${message}`),
    })
    return { w, applied, queries, logs }
  }

  it('reads each pull request once and applies what GitHub says', async () => {
    const { w, applied, queries } = watcher(
      async () => ({ data: { r0: { p0: { state: 'MERGED', isDraft: false } } } }),
      [
        'https://github.com/acme/app/pull/18',
        'https://github.com/Acme/app/pull/18/files',
        'https://example.com',
      ],
    )
    await w.refresh()
    expect(queries).toHaveLength(1)
    expect(queries[0]).toContain('pullRequest(number: 18)')
    expect(queries[0]).not.toContain('p1:')
    expect(applied).toEqual([{ 'https://github.com/acme/app/pull/18': 'done' }])
  })

  it('asks nothing when no pull request can change', async () => {
    const { w, queries } = watcher(async () => ({ data: {} }), [])
    await w.refresh()
    expect(queries).toEqual([])
  })

  it('keeps the last status when GitHub cannot be asked, logging the failure once', async () => {
    let fail: Error | null = new Error('getaddrinfo ENOTFOUND api.github.com')
    const { w, applied, logs } = watcher(async () => {
      if (fail) throw fail
      return { data: { r0: { p0: { state: 'CLOSED', isDraft: false } } } }
    }, ['https://github.com/acme/app/pull/18'])
    await w.refresh()
    await w.refresh()
    expect(applied).toEqual([])
    expect(logs).toEqual(['warn pull request status check failed'])
    fail = null
    await w.refresh()
    expect(applied).toEqual([{ 'https://github.com/acme/app/pull/18': 'failed' }])
    expect(logs).toEqual([
      'warn pull request status check failed',
      'info pull request status check works again',
    ])
  })

  it('asks in batches and joins a poll already running', async () => {
    const tracked = Array.from({ length: 120 }, (_, i) => `https://github.com/acme/app/pull/${i + 1}`)
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { w, queries } = watcher(async () => {
      await gate
      return null
    }, tracked)
    const first = w.refresh()
    const second = w.refresh()
    expect(second).toBe(first)
    release()
    await first
    expect(queries).toHaveLength(3)
  })
})
