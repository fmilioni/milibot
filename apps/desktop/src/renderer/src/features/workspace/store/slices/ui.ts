import type { StoreContext } from '../context'
import type { UiSlice } from '../types'

const TOAST_MS = 2500

export function uiSlice({ set }: StoreContext): UiSlice {
  let toastTimer: ReturnType<typeof setTimeout> | undefined
  return {
    toast: null,
    modal: null,
    search: '',
    renamingConversationId: null,

    showToast(key) {
      clearTimeout(toastTimer)
      set({ toast: key })
      toastTimer = setTimeout(() => set({ toast: null }), TOAST_MS)
    },
    setModal: (modal) => set({ modal }),
    setSearch: (search) => set({ search }),
    setRenaming: (conversationId) => set({ renamingConversationId: conversationId }),
  }
}
