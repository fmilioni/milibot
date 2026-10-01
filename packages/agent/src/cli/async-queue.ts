/** FIFO whose `next` waits for the next item (abortable). */
export class AsyncQueue<T> {
  private items: T[] = []
  private waiters: Array<(item: T) => void> = []

  push(item: T): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(item)
    else this.items.push(item)
  }

  next(signal: AbortSignal): Promise<T> {
    const item = this.items.shift()
    if (item !== undefined) return Promise.resolve(item)
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.waiters = this.waiters.filter((w) => w !== waiter)
        reject(signal.reason ?? new Error('aborted'))
      }
      const waiter = (value: T) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      }
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  clear(): void {
    this.items = []
  }
}
