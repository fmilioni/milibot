/** A layout choice kept in this window's storage; null when absent or storage is blocked. */
export function readPref(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

/** Keeps a layout choice; with storage blocked it lasts until the window reloads. */
export function writePref(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    // Storage blocked.
  }
}
