import { useCallback, useRef, useState } from 'react'

import { useAppStore } from '@/features/workspace/store'

/**
 * `run(action)` flags `busy` while the action runs and shows the error toast when it fails (the error is
 * logged, not rethrown). A second `run` while one is in flight is ignored.
 */
export function useAsyncAction(): [run: (action: () => Promise<unknown>) => Promise<void>, busy: boolean] {
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const run = useCallback(async (action: () => Promise<unknown>) => {
    if (running.current) return
    running.current = true
    setBusy(true)
    try {
      await action()
    } catch (err) {
      console.error('[action] failed', err)
      useAppStore.getState().showToast('error')
    } finally {
      running.current = false
      setBusy(false)
    }
  }, [])
  return [run, busy]
}
