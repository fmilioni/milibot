import { type LogFn, type setupEndpoints, VM_SETTING_KEYS } from '@milibot/shared'

import { errorMessage } from '../../errors'
import type { EndpointHandlers } from '../../handlers'
import {
  SETUP_PENDING_KEY,
  SETUP_VM_PENDING_KEY,
  SETUP_VM_WAIT_GOLDEN_KEY,
} from '../../workspace-db/setup-keys'
import { CLI_ENGINE_HOSTS, openRouterAccount } from '../providers'
import { isVmRunning, type VmController } from '../vm'
import type { WorkspaceStore } from '../workspace-store'

type SetupEndpoint = Extract<
  keyof typeof setupEndpoints,
  'configureSetupVm' | 'finishSetup' | 'checkOpenRouterKey'
>

export interface SetupDeps {
  store: WorkspaceStore
  vm: VmController
  /** Enqueues the first bot's introduction when its DM is still empty. */
  introduceFirstBot: () => void
  fetch?: typeof fetch
  log: LogFn
}

export class SetupRoutes {
  constructor(private readonly deps: SetupDeps) {}

  handlers(): EndpointHandlers<SetupEndpoint> {
    const { deps } = this
    const { store, vm, log } = deps

    /** The login terminals would stay on the first bot's desktop, where it works next. */
    const closeLoginTerminals = async () => {
      if (!isVmRunning(vm)) return
      try {
        for (const host of Object.values(CLI_ENGINE_HOSTS))
          await vm.runningGuest().killProcs(`login:${host.login.name}`)
      } catch (err) {
        log('warn', 'could not close the login terminals', { err: errorMessage(err) })
      }
    }

    return {
      configureSetupVm: ({ body }) => {
        store.settings.set(VM_SETTING_KEYS.cpus, body.cpus)
        store.settings.set(VM_SETTING_KEYS.memGb, body.memGb)
        store.settings.set(VM_SETTING_KEYS.dataGb, body.dataGb)
        store.settings.set(SETUP_VM_PENDING_KEY, false)
        store.settings.set(SETUP_VM_WAIT_GOLDEN_KEY, !body.start)
        if (body.start) {
          vm.start().catch((err: unknown) => log('warn', 'setup vm start failed', { err: errorMessage(err) }))
        }
        return vm.info()
      },
      finishSetup: async () => {
        store.settings.set(SETUP_PENDING_KEY, false)
        await closeLoginTerminals()
        deps.introduceFirstBot()
        return { ok: true as const }
      },
      checkOpenRouterKey: async ({ body }) => {
        const account = await openRouterAccount(deps.fetch ?? fetch, body.apiKey)
        if (account.error === null) return { valid: true, creditUsd: account.creditUsd, error: null }
        const invalid = /HTTP 40[13]/.test(account.error)
        return { valid: false, creditUsd: null, error: invalid ? 'invalid_key' : 'unreachable' }
      },
    }
  }
}
