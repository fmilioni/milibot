import { useAppStore } from './index'
import type { ToastKey } from './types'

/** Shows the toast `key` (the generic error by default) when `promise` rejects; resolves to undefined then. */
export function toastOnError<T>(promise: Promise<T>, key: ToastKey = 'error'): Promise<T | undefined> {
  return promise.catch((err: unknown) => {
    console.error('[toast]', err)
    useAppStore.getState().showToast(key)
    return undefined
  })
}

/** Copies `text` and confirms with the "Copied" toast (the error toast when the clipboard refuses). */
export function copyWithToast(text: string): void {
  const { showToast } = useAppStore.getState()
  void navigator.clipboard.writeText(text).then(
    () => showToast('copied'),
    () => showToast('error'),
  )
}
