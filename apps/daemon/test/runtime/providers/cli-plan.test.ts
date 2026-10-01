import type { CliUsage } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { parseClaudeAuthStatus } from '../../../src/runtime/providers/cli-engines/claude-code'
import {
  CliPlanTracker,
  PLAN_REFRESH_MS,
  PLAN_RETRY_MS,
  type RateLimitInfo,
  readCliPlan,
} from '../../../src/runtime/providers/cli-plan'

const AUTH_STATUS = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'someone@example.com',
  orgId: '0f3c2a1e-org-uuid',
  orgName: "Someone's Organization",
  subscriptionType: 'max',
})

const INFO: RateLimitInfo = {
  engine: 'claude_code',
  status: 'allowed',
  rateLimitType: 'five_hour',
  resetsAt: 1_000,
  windows: [{ id: 'five_hour', utilization: 0.2, resetsAt: 1_000 }],
}

describe('parseClaudeAuthStatus', () => {
  it('keeps only the subscription type', () => {
    expect(parseClaudeAuthStatus(AUTH_STATUS)).toBe('max')
    expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, subscriptionType: ' Pro ' }))).toBe('pro')
  })

  it('rejects logged-out, missing, odd or malformed answers', () => {
    expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: false, subscriptionType: 'max' }))).toBeNull()
    expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: true }))).toBeNull()
    expect(
      parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, subscriptionType: 'a b<script>' })),
    ).toBeNull()
    expect(parseClaudeAuthStatus('Not logged in')).toBeNull()
    expect(parseClaudeAuthStatus('null')).toBeNull()
  })
})

describe('readCliPlan', () => {
  const ok = async () => ({ code: 0, stdout: AUTH_STATUS })

  it('asks the CLI in subscription mode', async () => {
    expect(await readCliPlan({ type: 'claude_code', authMode: 'subscription' }, ok)).toBe('max')
    expect(await readCliPlan({ type: 'claude_code', authMode: null }, ok)).toBe('max')
    expect(
      await readCliPlan({ type: 'claude_code', authMode: 'subscription' }, async () => ({
        code: 1,
        stdout: AUTH_STATUS,
      })),
    ).toBeNull()
  })

  it('is api with a key or token, without running the CLI', async () => {
    const never = async (): Promise<never> => {
      throw new Error('must not run')
    }
    expect(await readCliPlan({ type: 'claude_code', authMode: 'api_key' }, never)).toBe('api')
    expect(await readCliPlan({ type: 'claude_code', authMode: 'auth_token' }, never)).toBe('api')
    expect(await readCliPlan({ type: 'anthropic', authMode: null }, never)).toBeUndefined()
  })

  it('has nothing to ask for a Codex subscription (its plan comes with the quota)', async () => {
    const never = async (): Promise<never> => {
      throw new Error('must not run')
    }
    expect(await readCliPlan({ type: 'codex', authMode: 'subscription' }, never)).toBeUndefined()
    expect(await readCliPlan({ type: 'codex', authMode: 'api_key' }, never)).toBe('api')
  })
})

function setup(answers: Array<string | null | undefined | Error>) {
  let clock = 1_000_000
  const saved = new Map<string, string>()
  const emitted: CliUsage[] = []
  let reads = 0
  const tracker = new CliPlanTracker({
    now: () => clock,
    readPlan: async () => {
      const answer = answers[Math.min(reads++, answers.length - 1)]
      if (answer instanceof Error) throw answer
      return answer
    },
    loadUsage: (id) => {
      const raw = saved.get(id)
      return raw ? (JSON.parse(raw) as CliUsage) : null
    },
    saveUsage: (usage) => {
      saved.set(usage.providerId, JSON.stringify(usage))
      emitted.push(usage)
    },
  })
  return {
    tracker,
    saved,
    emitted,
    reads: () => reads,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('CliPlanTracker', () => {
  it('adds the plan to the stored usage and re-emits it', async () => {
    const t = setup(['max'])
    t.tracker.recordRateLimit('prv_1', INFO)
    await flush()
    expect(t.emitted.map((u) => u.plan)).toEqual([undefined, 'max'])
    expect(t.tracker.usage('prv_1')?.plan).toBe('max')

    t.tracker.recordRateLimit('prv_1', { ...INFO, status: 'allowed_warning' })
    expect(t.emitted.at(-1)).toMatchObject({ status: 'allowed_warning', plan: 'max' })
    expect(t.reads()).toBe(1)
  })

  it('asks at most once per 6 hours', async () => {
    const t = setup(['max', 'pro'])
    t.tracker.recordRateLimit('prv_1', INFO)
    t.tracker.recordRateLimit('prv_1', INFO)
    await flush()
    t.advance(PLAN_REFRESH_MS - 1)
    t.tracker.recordRateLimit('prv_1', INFO)
    await flush()
    expect(t.reads()).toBe(1)

    t.advance(1)
    t.tracker.recordRateLimit('prv_1', INFO)
    await flush()
    expect(t.reads()).toBe(2)
    expect(t.tracker.usage('prv_1')?.plan).toBe('pro')
  })

  it('retries 10 minutes after a failure', async () => {
    const t = setup([new Error('VM_UNAVAILABLE'), null, 'max'])
    t.tracker.recordRateLimit('prv_1', INFO)
    await flush()
    expect(t.tracker.usage('prv_1')?.plan).toBeUndefined()
    await flush()
    expect(t.reads()).toBe(1)

    t.advance(PLAN_RETRY_MS)
    t.tracker.usage('prv_1')
    await flush()
    expect(t.reads()).toBe(2)

    t.advance(PLAN_RETRY_MS - 1)
    t.tracker.usage('prv_1')
    await flush()
    expect(t.reads()).toBe(2)

    t.advance(1)
    t.tracker.usage('prv_1')
    await flush()
    expect(t.reads()).toBe(3)
    expect(t.tracker.usage('prv_1')?.plan).toBe('max')
  })

  it('never asks again for a provider without a plan source until it is forgotten', async () => {
    const t = setup([undefined, 'api'])
    t.tracker.recordRateLimit('prv_1', INFO)
    await flush()
    t.advance(PLAN_REFRESH_MS * 4)
    t.tracker.usage('prv_1')
    t.tracker.recordRateLimit('prv_1', INFO)
    await flush()
    expect(t.reads()).toBe(1)

    t.tracker.forget('prv_1')
    await t.tracker.refresh('prv_1')
    expect(t.reads()).toBe(2)
  })

  it('keeps a plan learned before any usage for the first rate limit event', async () => {
    const t = setup(['max'])
    await t.tracker.refresh('prv_1')
    expect(t.saved.size).toBe(0)
    expect(t.tracker.recordRateLimit('prv_1', INFO).plan).toBe('max')
  })

  it('checks again right after forget', async () => {
    const t = setup(['max', 'api'])
    await t.tracker.refresh('prv_1')
    t.tracker.forget('prv_1')
    await t.tracker.refresh('prv_1')
    expect(t.reads()).toBe(2)
  })

  it('persists only the plan, never account details', async () => {
    const t = setup([])
    const tracker = new CliPlanTracker({
      now: () => 0,
      readPlan: () =>
        readCliPlan({ type: 'claude_code', authMode: 'subscription' }, async () => ({
          code: 0,
          stdout: AUTH_STATUS,
        })),
      loadUsage: (id) => {
        const raw = t.saved.get(id)
        return raw ? (JSON.parse(raw) as CliUsage) : null
      },
      saveUsage: (usage) => t.saved.set(usage.providerId, JSON.stringify(usage)),
    })
    tracker.recordRateLimit('prv_1', INFO)
    await flush()
    const stored = t.saved.get('prv_1') ?? ''
    expect(JSON.parse(stored)).toMatchObject({ plan: 'max' })
    for (const secret of ['someone@example.com', 'org-uuid', 'Organization', 'claude.ai', 'firstParty']) {
      expect(stored).not.toContain(secret)
    }
    expect(Object.keys(JSON.parse(stored) as object).sort()).toEqual(
      ['engine', 'plan', 'providerId', 'rateLimitType', 'resetsAt', 'status', 'updatedAt', 'windows'].sort(),
    )
  })
})
