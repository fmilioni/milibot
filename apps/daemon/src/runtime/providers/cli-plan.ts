import type { CliUsage, Provider } from '@milibot/shared'

import { errorMessage } from '../../errors'
import { cliEngineHost } from './cli-engines'

export const PLAN_REFRESH_MS = 6 * 60 * 60 * 1000
export const PLAN_RETRY_MS = 10 * 60 * 1000
/** Least time between two quota readings of an engine that reports it only on demand (Antigravity's `/usage`). */
export const QUOTA_REFRESH_MS = 2 * 60 * 1000

export type RunAsAgent = (command: string) => Promise<{ code: number | null; stdout: string }>

/**
 * `api` outside subscription mode; otherwise asks the engine's CLI logged in inside the VM. `undefined` when
 * there is nothing to ask: not a CLI provider, or an engine that reports its plan with its quota (Codex's
 * `planType` of the rate limits).
 */
export async function readCliPlan(
  provider: Pick<Provider, 'type' | 'authMode'>,
  runAsAgent: RunAsAgent,
): Promise<string | null | undefined> {
  const host = cliEngineHost(provider.type)
  if (!host) return undefined
  if (provider.authMode && provider.authMode !== 'subscription') return 'api'
  if (host.plan === 'quota') return undefined
  const result = await runAsAgent(host.plan.command)
  return result.code === 0 ? host.plan.parse(result.stdout) : null
}

export type RateLimitInfo = Omit<CliUsage, 'providerId' | 'plan' | 'updatedAt'>

export interface CliPlanTrackerDeps {
  now: () => number
  /** null: no usable answer (asked again after `PLAN_RETRY_MS`); undefined: the provider has no plan to ask for. */
  readPlan: (providerId: string) => Promise<string | null | undefined>
  loadUsage: (providerId: string) => CliUsage | null
  /** Persists and broadcasts (`provider.usage`). */
  saveUsage: (usage: CliUsage) => void
  /**
   * Reads the quota of an engine whose turns stream none (`CliEngineHost.quota`): undefined when the provider
   * has no such reading, null when it gave nothing usable.
   */
  readQuota?: (providerId: string) => Promise<RateLimitInfo | null | undefined>
  log?: (message: string, extra?: Record<string, unknown>) => void
}

/**
 * Keeps the account plan inside each CLI provider's usage state (Claude Code and Codex quotas share it). The
 * CLI is asked at most once per `PLAN_REFRESH_MS` per provider, and again after `PLAN_RETRY_MS` when the answer
 * was unusable.
 */
export class CliPlanTracker {
  private readonly plans = new Map<string, string>()
  private readonly nextCheckAt = new Map<string, number>()
  private readonly inFlight = new Map<string, Promise<void>>()
  private readonly nextQuotaAt = new Map<string, number>()
  private readonly quotaInFlight = new Set<string>()

  constructor(private readonly deps: CliPlanTrackerDeps) {}

  /** `reportedPlan`: the plan the quota update itself carried (Codex). */
  recordRateLimit(providerId: string, info: RateLimitInfo, reportedPlan?: string | null): CliUsage {
    const plan = this.plans.get(providerId) ?? reportedPlan ?? this.deps.loadUsage(providerId)?.plan ?? null
    const usage: CliUsage = {
      providerId,
      ...info,
      ...(plan ? { plan } : {}),
      updatedAt: this.deps.now(),
    }
    this.deps.saveUsage(usage)
    void this.refresh(providerId)
    return usage
  }

  usage(providerId: string): CliUsage | null {
    const usage = this.deps.loadUsage(providerId)
    if (usage && !usage.plan) void this.refresh(providerId)
    void this.refreshQuota(providerId)
    return usage
  }

  /** Reads an on-demand quota when one is due (at most once per `QUOTA_REFRESH_MS`); never rejects. */
  async refreshQuota(providerId: string): Promise<void> {
    const readQuota = this.deps.readQuota
    if (!readQuota || this.quotaInFlight.has(providerId)) return
    if (this.deps.now() < (this.nextQuotaAt.get(providerId) ?? 0)) return
    this.quotaInFlight.add(providerId)
    this.nextQuotaAt.set(providerId, this.deps.now() + QUOTA_REFRESH_MS)
    try {
      const info = await readQuota(providerId)
      if (info === undefined) this.nextQuotaAt.set(providerId, Number.POSITIVE_INFINITY)
      else if (info) this.recordRateLimit(providerId, info)
    } catch (err) {
      this.deps.log?.('cli quota check failed', { providerId, err: errorMessage(err) })
    } finally {
      this.quotaInFlight.delete(providerId)
    }
  }

  /** Resolves when the check (if one was due) finished; never rejects. */
  refresh(providerId: string): Promise<void> {
    const running = this.inFlight.get(providerId)
    if (running) return running
    if (this.deps.now() < (this.nextCheckAt.get(providerId) ?? 0)) return Promise.resolve()
    const check = this.check(providerId).finally(() => this.inFlight.delete(providerId))
    this.inFlight.set(providerId, check)
    return check
  }

  /** Drops what is known about a provider (e.g. its auth mode changed). */
  forget(providerId: string): void {
    this.plans.delete(providerId)
    this.nextCheckAt.delete(providerId)
    this.nextQuotaAt.delete(providerId)
  }

  private async check(providerId: string): Promise<void> {
    let plan: string | null | undefined = null
    try {
      plan = await this.deps.readPlan(providerId)
    } catch (err) {
      this.deps.log?.('cli plan check failed', { providerId, err: errorMessage(err) })
    }
    const now = this.deps.now()
    if (plan === undefined) {
      this.nextCheckAt.set(providerId, Number.POSITIVE_INFINITY)
      return
    }
    if (!plan) {
      this.nextCheckAt.set(providerId, now + PLAN_RETRY_MS)
      return
    }
    this.nextCheckAt.set(providerId, now + PLAN_REFRESH_MS)
    this.plans.set(providerId, plan)
    const usage = this.deps.loadUsage(providerId)
    if (usage && usage.plan !== plan) this.deps.saveUsage({ ...usage, plan })
  }
}
