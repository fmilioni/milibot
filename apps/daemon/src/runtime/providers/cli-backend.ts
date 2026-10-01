import {
  CLI_ENGINE_DRIVERS,
  CLI_PROC_LABEL_PREFIXES,
  cliKeys,
  type GuestCliBackend,
  KILL_GRACE_MS,
} from '@milibot/agent/cli'
import { type CliEngine, CliUsage, isCliEngine, type LogFn, type WorkspaceEvent } from '@milibot/shared'

import { errorMessage } from '../../errors'
import type { McpToolServer } from '../mcp-server'
import type { GuestClient, VmController } from '../vm'
import type { WorkspaceStore } from '../workspace-store'
import { cliEngineHost } from './cli-engines'
import { CliPlanTracker, readCliPlan } from './cli-plan'
import type { ProviderStore } from './store'

const USAGE_KEY = (providerId: string) => `cli.usage.${providerId}`

export interface CliBackend extends GuestCliBackend {
  readonly engine: CliEngine
  /**
   * Stops the engine's processes a previous runtime left in the VM (it crashed or restarted with the VM kept
   * running): nobody reads them any more. Runs once per runtime, before this one starts any.
   */
  sweepOrphans(): Promise<void>
}

/** Stops the running processes whose label starts with one of `prefixes`: SIGTERM, then SIGKILL after `graceMs`. */
export async function killLabelledProcs(
  guest: Pick<GuestClient, 'listProcs' | 'procSignal'>,
  prefixes: readonly string[],
  graceMs = KILL_GRACE_MS,
): Promise<number> {
  const { procs } = await guest.listProcs()
  const ids = procs
    .filter((p) => p.running && prefixes.some((prefix) => p.label?.startsWith(prefix)))
    .map((p) => p.id)
  for (const id of ids) await guest.procSignal(id, 'SIGTERM').catch(() => undefined)
  if (ids.length) {
    const timer = setTimeout(() => {
      void (async () => {
        for (const id of ids) await guest.procSignal(id, 'SIGKILL').catch(() => undefined)
      })()
    }, graceMs)
    timer.unref?.()
  }
  return ids.length
}

/**
 * CLI engine processes of the bots (Claude Code, Codex) run in the VM as `agent`, reaching Milibot's tools
 * through its MCP server with a token of their engine.
 */
export function createCliBackend(deps: {
  engine: CliEngine
  vm: VmController
  store: WorkspaceStore
  mcp: McpToolServer
  /** Runs before every process (Codex: waits for its CLI to be installed in the VM). */
  prepare?: () => Promise<void>
  log?: LogFn
}): CliBackend {
  const { engine, vm, store, mcp } = deps
  const sessionKey = cliKeys(engine).session
  let sweep: Promise<void> | null = null
  const sweepOrphans = (guest: GuestClient): Promise<void> =>
    (sweep ??= killLabelledProcs(guest, CLI_PROC_LABEL_PREFIXES[engine]).then(
      (count) => {
        if (count) deps.log?.('info', 'stopped CLI processes left by a previous runtime', { engine, count })
      },
      (err: unknown) => {
        sweep = null
        deps.log?.('warn', 'could not clear old CLI processes', { engine, err: errorMessage(err) })
      },
    ))
  return {
    engine,
    sweepOrphans: async () => {
      if (vm.status().state === 'running') await sweepOrphans(vm.runningGuest())
    },
    startProcess: async (spec) => {
      const guest = await vm.guest()
      await sweepOrphans(guest)
      await deps.prepare?.()
      // Never retried once this runtime has a process of its own: it would be swept too.
      sweep = Promise.resolve()
      return guest.startProc({ ...spec })
    },
    events: (procId, since, signal) => ({
      async *[Symbol.asyncIterator]() {
        yield* vm.runningGuest().procEvents(procId, since, signal)
      },
    }),
    writeStdin: async (procId, data, eof) => {
      await vm.runningGuest().procStdin(procId, data, eof ?? false)
    },
    signal: async (procId, signal) => {
      await vm.runningGuest().procSignal(procId, signal)
    },
    writeAgentFile: async (name, content) => {
      const result = await (
        await vm.guest()
      ).exec({
        user: 'agent',
        cmd: 'umask 077 && f="$HOME/.milibot/$FILE_NAME" && mkdir -p "${f%/*}" && cat > "$f" && printf %s "$f"',
        env: { FILE_NAME: name },
        stdin: content,
        timeoutMs: 15_000,
      })
      if (result.code !== 0) throw new Error(`could not write ${name}: ${result.stderr.trim()}`)
      return result.stdout.trim()
    },
    mcpEndpoint: (botId, laneKey) => mcp.endpointFor(botId, laneKey, engine),
    getSessionId: (laneKey) => store.settings.get<string | null>(sessionKey(laneKey), null),
    setSessionId: (laneKey, sessionId) => store.settings.set(sessionKey(laneKey), sessionId),
  }
}

/** Subscription quota and plan of each CLI provider (Claude Code, Codex), kept in the workspace settings. */
export function createCliPlanTracker(deps: {
  vm: VmController
  store: WorkspaceStore
  providers: ProviderStore
  emit: (event: WorkspaceEvent) => void
  now: () => number
  log: LogFn
}): CliPlanTracker {
  const { vm, store, providers, emit } = deps
  const loadUsage = (providerId: string): CliUsage | null => {
    const parsed = CliUsage.safeParse(store.settings.get<unknown>(USAGE_KEY(providerId), null))
    return parsed.success ? parsed.data : null
  }
  return new CliPlanTracker({
    now: deps.now,
    readPlan: async (providerId) =>
      readCliPlan(await providers.get(providerId), async (cmd) => {
        // Waits for a boot already in progress (runtime just adopted the VM) but never starts one.
        const guest = vm.status().state === 'starting' ? await vm.guest() : vm.runningGuest()
        return guest.exec({ user: 'agent', cmd, timeoutMs: 30_000 })
      }),
    loadUsage,
    readQuota: async (providerId) => {
      const provider = await providers.get(providerId)
      const quota = cliEngineHost(provider.type)?.quota
      if (
        !quota ||
        !isCliEngine(provider.type) ||
        (provider.authMode && provider.authMode !== 'subscription')
      )
        return undefined
      if (vm.status().state !== 'running') return null
      const result = await vm.runningGuest().exec({ user: 'agent', cmd: quota.command, timeoutMs: 45_000 })
      const update = quota.parse(result.stdout)
      if (update === null) return null
      const merged = CLI_ENGINE_DRIVERS[provider.type].mergeQuota(
        loadUsage(providerId),
        providerId,
        update,
        deps.now(),
      )
      if (!merged) return null
      const { providerId: _id, plan: _plan, updatedAt: _at, ...info } = merged
      return info
    },
    saveUsage: (usage) => {
      store.settings.set(USAGE_KEY(usage.providerId), usage)
      emit({ type: 'provider.usage', payload: { usage } })
    },
    log: (message, extra) => deps.log('info', message, extra),
  })
}
