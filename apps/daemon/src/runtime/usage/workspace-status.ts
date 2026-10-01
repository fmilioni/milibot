import {
  type costEndpoints,
  USAGE_COUNTER_RESET_KEY,
  type workspaceEndpoints,
  type WorkspaceEvent,
  type WorkspaceStatus,
} from '@milibot/shared'

import type { EndpointHandlers } from '../../handlers'
import type { LlmCallStore } from '../observability'
import type { SettingsStore } from '../settings'
import type { VmController } from '../vm'

type WorkspaceStatusEndpoint =
  | Extract<keyof typeof workspaceEndpoints, 'getWorkspaceStatus'>
  | Extract<keyof typeof costEndpoints, 'resetUsageCounter'>

/** The sidebar footer: VM state and today's spend (resettable). */
export class WorkspaceStatusService {
  constructor(
    private readonly deps: {
      vm: Pick<VmController, 'status'>
      settings: SettingsStore
      llmCalls: LlmCallStore
      emit: (event: WorkspaceEvent) => void
      now: () => number
    },
  ) {}

  status(): WorkspaceStatus {
    const { vm, settings, llmCalls, now } = this.deps
    return {
      vm: vm.status(),
      ...llmCalls.usageStatus(now(), settings.get<number | null>(USAGE_COUNTER_RESET_KEY, null)),
    }
  }

  changed(): void {
    this.deps.emit({ type: 'workspace.status', payload: { status: this.status() } })
  }

  handlers(): EndpointHandlers<WorkspaceStatusEndpoint> {
    return {
      getWorkspaceStatus: () => this.status(),
      resetUsageCounter: () => {
        this.deps.settings.set(USAGE_COUNTER_RESET_KEY, this.deps.now())
        this.changed()
        return this.status()
      },
    }
  }
}
