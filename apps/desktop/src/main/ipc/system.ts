import { appLoginItem } from '../platform/login-item'
import type { InvokeHandlers } from './handle'
import type { IpcDeps } from './register'

export function systemInvokes({ settings, keepAwake }: IpcDeps) {
  return {
    setThemeSource: (_event, [theme]) => settings.setTheme(theme),

    getLoginItem: async () => {
      const item = appLoginItem()
      return item.supported ? await item.enabled() : null
    },

    setLoginItem: (_event, [enabled]) => appLoginItem().set(enabled),

    getKeepAwake: () => keepAwake.state,
  } satisfies Partial<InvokeHandlers>
}
