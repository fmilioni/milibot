/**
 * A service that is built after the ones that call it: they hold the reference and only read it once the
 * container has set it (`get` throws before that, never returning a half-built graph).
 */
export interface Lazy<T> {
  get(): T
  set(value: T): T
}

export function lazy<T>(name: string): Lazy<T> {
  let value: T | undefined
  let ready = false
  return {
    get() {
      if (!ready) throw new Error(`${name} is used before the runtime built it`)
      return value as T
    },
    set(next) {
      if (ready) throw new Error(`${name} was already set`)
      value = next
      ready = true
      return next
    },
  }
}
