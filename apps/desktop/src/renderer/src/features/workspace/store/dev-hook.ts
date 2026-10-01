import type { WorkspaceEvent } from '@milibot/shared'

import { emitWorkspaceEvent } from '@/api/daemon'

import { useAppStore } from './index'

/** Dev only: `window.__milibotDev.applyWorkspaceEvent(event)` drives the UI from DevTools/CDP as the stream would. */
export function installDevHook(): void {
  Object.assign(window, {
    __milibotDev: {
      applyWorkspaceEvent: (event: WorkspaceEvent) => {
        const { workspaceId, receiveWorkspaceEvent } = useAppStore.getState()
        receiveWorkspaceEvent(event)
        if (workspaceId) emitWorkspaceEvent(workspaceId, event)
      },
    },
  })
}
