import { openQemuInstaller } from '../platform/host/qemu-installer'
import { appLoginItem } from '../platform/login-item'
import type { InvokeHandlers } from './handle'
import type { IpcDeps } from './register'

export function systemInvokes({ settings }: IpcDeps) {
  return {
    setThemeSource: (_event, [theme]) => settings.setTheme(theme),

    openQemuInstaller: () => openQemuInstaller(settings.language),

    getLoginItem: async () => {
      const item = appLoginItem()
      return item.supported ? await item.enabled() : null
    },

    setLoginItem: (_event, [enabled]) => appLoginItem().set(enabled),
  } satisfies Partial<InvokeHandlers>
}
