/** Data fetched on demand and cached in a store, keyed by id. */
export interface Loadable<T> {
  data: T | null
  loading: boolean
  error: boolean
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
 * Loads `key`'s entry: `loading` (keeping the data it had) while `load` runs, then its data or `error`.
 * Nothing is written after `load` settles unless `isCurrent()` (e.g. the store still shows that workspace).
 */
export async function loadEntry<T>(
  entries: () => Record<string, Loadable<T>>,
  write: (entries: Record<string, Loadable<T>>) => void,
  key: string,
  load: () => Promise<T>,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const put = (patch: Partial<Loadable<T>>) => write(patchLoadable(entries(), key, patch))
  put({ loading: true, error: false })
  try {
    const data = await load()
    if (isCurrent()) put({ data, loading: false, error: false })
  } catch {
    if (isCurrent()) put({ loading: false, error: true })
  }
}
