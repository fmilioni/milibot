/** Waits `ms`; an abort rejects at once with `abortError()` (default: the signal's reason). */
export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
  abortError: () => unknown = () => signal?.reason ?? new Error('aborted'),
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
