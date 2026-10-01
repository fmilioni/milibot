import type { AppEvent, GoldenStatus } from '@milibot/shared'
import { create } from 'zustand'

import { api } from '@/api/daemon'

interface SetupState {
  golden: GoldenStatus | null
  loadGolden(): Promise<void>
  buildGolden(): Promise<void>
}

/** The golden image the setup (and the system update) builds VMs from; follows `golden.status`. */
export const useSetupStore = create<SetupState>()((set) => ({
  golden: null,

  async loadGolden() {
    set({ golden: await api().call('getGoldenImage', {}) })
  },

  async buildGolden() {
    set({ golden: await api().call('buildGoldenImage', {}) })
  },
}))

export function applySetupAppEvent(event: AppEvent): void {
  if (event.type === 'golden.status') useSetupStore.setState({ golden: event.payload.status })
}
