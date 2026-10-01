import type { MilibotBridge } from '../../bridge/contract'

declare global {
  interface Window {
    milibot: MilibotBridge
  }
}

export {}
