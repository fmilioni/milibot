import { api, connectDaemon, followAppEvents } from '@/api/daemon'

import type { StoreContext } from '../context'
import type { ConnectionSlice } from '../types'

export function connectionSlice(ctx: StoreContext): ConnectionSlice {
  const { set } = ctx
  let booting: Promise<void> | null = null

  const bootOnce = async (chat: boolean) => {
    ctx.options.withChat = chat
    set({ phase: 'booting', bootError: null })
    try {
      const context = await window.milibot.getContext()
      connectDaemon(context.daemon)
      const [settings, workspaces] = await Promise.all([
        api().call('getAppSettings', {}),
        api().call('listWorkspaces', {}),
      ])
      ctx.applySettings(settings)
      set({ workspaces, workspaceId: context.workspaceId })
      followAppEvents(ctx.receiveAppEvent)
      ctx.followWorkspace(context.workspaceId)
      await ctx.loadWorkspaceData(context.workspaceId)
      set({ phase: 'ready' })
    } catch (err) {
      set({ phase: 'error', bootError: err instanceof Error ? err.message : String(err) })
    }
  }

  return {
    phase: 'booting',
    bootError: null,
    connectionState: 'connecting',

    boot(options) {
      booting ??= bootOnce(options?.chat ?? true).finally(() => {
        booting = null
      })
      return booting
    },

    receiveWorkspaceEvent: ctx.receiveWorkspaceEvent,
  }
}
