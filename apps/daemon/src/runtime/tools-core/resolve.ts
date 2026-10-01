import { foldKey } from './text'

export type RefMatch<T> = { found: T } | { ambiguous: T[] } | { missing: true }

/** What to do when several rows match: take the first (after `prefer`), or report them. */
type OnAmbiguous = 'first' | 'report'

export interface RefOptions<T> {
  id: (row: T) => string
  /** Names matched exactly, then as substrings (case and accents ignored). */
  names: (row: T) => readonly string[]
  /** Rows that may match by substring (all by default). */
  partialAllowed?: (row: T) => boolean
  /** Tie-breaks among the matches, in order (e.g. the bot's own first). */
  prefer?: ReadonlyArray<(row: T) => boolean>
  ambiguous: { exact: OnAmbiguous; partial: OnAmbiguous }
}

/** A row a bot names: by id, then by exact name, then by a name containing the reference. */
export function resolveByRef<T>(rows: readonly T[], ref: string, options: RefOptions<T>): RefMatch<T> {
  const value = ref.trim()
  const byId = rows.find((row) => options.id(row) === value)
  if (byId !== undefined) return { found: byId }
  const key = foldKey(value)
  if (!key) return { missing: true }
  const exact = rows.filter((row) => options.names(row).some((name) => foldKey(name) === key))
  const partialAllowed = options.partialAllowed ?? (() => true)
  const matches = exact.length
    ? exact
    : rows.filter(
        (row) => partialAllowed(row) && options.names(row).some((name) => foldKey(name).includes(key)),
      )
  if (matches.length === 0) return { missing: true }
  const ranked = rankBy(matches, options.prefer ?? [])
  const onAmbiguous = exact.length ? options.ambiguous.exact : options.ambiguous.partial
  if (ranked.length === 1 || onAmbiguous === 'first') return { found: ranked[0] as T }
  return { ambiguous: ranked }
}

function rankBy<T>(rows: T[], prefer: ReadonlyArray<(row: T) => boolean>): T[] {
  if (prefer.length === 0) return rows
  const rank = (row: T) => {
    const index = prefer.findIndex((p) => p(row))
    return index === -1 ? prefer.length : index
  }
  return rows
    .map((row, i) => ({ row, i, r: rank(row) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.row)
}
