/** Data fetched on demand and cached in a store, keyed by id. */
export interface Loadable<T> {
  data: T | null
  loading: boolean
  error: boolean
  /** The data on screen is out of date (the server said it changed): reload it, showing it meanwhile. */
  stale?: boolean
}

/** `entries` with `key`'s entry patched (an entry not there yet starts empty). */
export function patchLoadable<T>(
  entries: Record<string, Loadable<T>>,
  key: string,
  patch: Partial<Loadable<T>>,
): Record<string, Loadable<T>> {
  return { ...entries, [key]: { data: null, loading: false, error: false, ...entries[key], ...patch } }
}

/**
 * Loads `key`'s entry: `loading` (keeping the data it had, no longer `stale`) while `load` runs, then its data
 * or `error`. Nothing is written after `load` settles unless `isCurrent()` (e.g. the store still shows that
 * workspace, or no newer load of the key started).
 */
export async function loadEntry<T>(
  entries: () => Record<string, Loadable<T>>,
  write: (entries: Record<string, Loadable<T>>) => void,
  key: string,
  load: () => Promise<T>,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const put = (patch: Partial<Loadable<T>>) => write(patchLoadable(entries(), key, patch))
  put({ loading: true, error: false, ...(entries()[key]?.stale ? { stale: false } : {}) })
  try {
    const data = await load()
    if (isCurrent()) put({ data, loading: false, error: false })
  } catch {
    if (isCurrent()) put({ loading: false, error: true })
  }
}

/** `entries` with every entry whose key passes `match` flagged `stale` (data kept for the reload). */
export function markStale<T>(
  entries: Record<string, Loadable<T>>,
  match: (key: string) => boolean,
): Record<string, Loadable<T>> {
  return Object.fromEntries(
    Object.entries(entries).map(([key, entry]) => [key, match(key) ? { ...entry, stale: true } : entry]),
  )
}
