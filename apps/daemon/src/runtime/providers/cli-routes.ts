import { cliUserSettings } from '@milibot/agent/cli'
import {
  CLI_ENGINE_INFO,
  type CliEngine,
  type cliEngineEndpoints,
  cliSettingKeys,
  type LogFn,
} from '@milibot/shared'

import { DaemonError, errorMessage } from '../../errors'
import type { EndpointHandlers } from '../../handlers'
import { isVmRunning, type VmController } from '../vm'
import type { WorkspaceStore } from '../workspace-store'
import { CLI_ENGINE_HOSTS } from './cli-engines'
import type { CliEngineRuntime, CliInstaller } from './cli-engines/host'
import { loginTerminalOpen, openLoginTerminal } from './cli-login'

/** Asking every bot user costs a CLI start each; the answer changes only when someone logs in. */
const ELSEWHERE_CHECK_MS = 10_000

export interface CliEngineRoutesDeps {
  store: WorkspaceStore
  vm: VmController
  runtimes: Record<CliEngine, CliEngineRuntime>
  now?: () => number
  log: LogFn
}

function unsupported(engine: CliEngine, capability: string): DaemonError {
  return new DaemonError('unsupported', `${CLI_ENGINE_INFO[engine].displayName} has no ${capability}`, {
    engine,
    capability,
  })
}

/** The per-engine routes (`/cli/:engine/...`), answered by the engine's host and runtime. */
export class CliEngineRoutes {
  /** Per engine: whether a bot's own account was logged in, at the last check. */
  private readonly elsewhere = new Map<CliEngine, { at: number; value: boolean }>()

  constructor(private readonly deps: CliEngineRoutesDeps) {}

  private installer(engine: CliEngine): CliInstaller {
    const installer = this.deps.runtimes[engine].installer
    if (!installer) throw unsupported(engine, 'installer')
    return installer
  }

  handlers(): EndpointHandlers<keyof typeof cliEngineEndpoints> {
    const { store, vm, log } = this.deps
    const now = this.deps.now ?? Date.now
    const settings = (engine: CliEngine) =>
      cliUserSettings(engine, (key, fallback) => store.settings.get(key, fallback))

    return {
      getCliLoginStatus: async ({ params: { engine } }) => {
        const unknown = { loggedIn: null, terminalOpen: null, loggedInElsewhere: false }
        if (!isVmRunning(vm)) return unknown
        const host = CLI_ENGINE_HOSTS[engine]
        const guest = vm.runningGuest()
        const firstBot = store.bots.first()
        // One request at a time: the VM's port forward takes a single connection at once.
        const loggedIn = await host.loggedIn(guest).catch((err: unknown) => {
          log('warn', 'cli login status failed', { engine, err: errorMessage(err) })
          return null
        })
        const terminalOpen = firstBot
          ? await loginTerminalOpen(guest, host.login, firstBot.displayNum).catch(() => null)
          : null
        let loggedInElsewhere = false
        if (loggedIn === false && host.loggedInElsewhere) {
          const last = this.elsewhere.get(engine)
          if (!last || now() - last.at >= ELSEWHERE_CHECK_MS) {
            const slugs = store.bots.list().map((b) => b.slug)
            this.elsewhere.set(engine, { at: now(), value: await host.loggedInElsewhere(guest, slugs) })
          }
          loggedInElsewhere = this.elsewhere.get(engine)?.value ?? false
        }
        return { loggedIn, terminalOpen, loggedInElsewhere }
      },
      openCliLoginTerminal: async ({ params: { engine }, body }) => {
        const bot = body.botId ? store.bots.get(body.botId) : store.bots.first()
        if (!bot) throw new DaemonError('not_found', 'No bot to open the terminal on')
        if (!isVmRunning(vm)) {
          void vm.start().catch((err: unknown) => log('warn', 'vm start failed', { err: errorMessage(err) }))
          throw new DaemonError('conflict', 'The workspace VM is not running', { reason: 'vm_not_running' })
        }
        const installer = this.deps.runtimes[engine].installer
        if (installer && (await installer.install()).version === null)
          throw new DaemonError('conflict', 'The CLI could not be installed in the VM', {
            reason: 'cli_install_failed',
          })
        await vm.provisionBot(bot)
        // Reopening the setup (or clicking again) brings no second terminal while one is open.
        await openLoginTerminal(vm.runningGuest(), CLI_ENGINE_HOSTS[engine].login, bot.displayNum)
        return { botId: bot.id }
      },
      getCliInstall: async ({ params: { engine } }) => this.installer(engine).status(),
      installCli: async ({ params: { engine } }) => this.installer(engine).install(),
      getCliSettings: ({ params: { engine } }) => settings(engine),
      updateCliSettings: async ({ params: { engine }, body }) => {
        if (body.compactSystemPrompt !== undefined && !CLI_ENGINE_INFO[engine].compactSystemPrompt)
          throw unsupported(engine, 'compactSystemPrompt')
        store.settings.setMany(cliSettingKeys(engine), body)
        return settings(engine)
      },
    }
  }
}
