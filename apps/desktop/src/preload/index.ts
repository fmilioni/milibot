import { contextBridge, ipcRenderer, webUtils } from 'electron'

import { windowKindFromArgv } from '../bridge/channels'
import { createBridge } from './bridge'

contextBridge.exposeInMainWorld(
  'milibot',
  createBridge({
    kind: windowKindFromArgv(process.argv) ?? 'vm',
    platform: process.platform,
    ipc: ipcRenderer,
    getPathForFile: (file) => webUtils.getPathForFile(file),
  }),
)
