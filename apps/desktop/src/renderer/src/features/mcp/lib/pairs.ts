import type { McpKeyValueInput, McpServer } from '@milibot/shared'

/** A row of the env/headers editor; `key` only identifies the row. */
export interface Pair {
  key: number
  name: string
  value: string
  secret: boolean
  /** A secret already stored: an empty value keeps it. */
  saved: boolean
}

let nextKey = 1
export const pair = (p: Partial<Pair> = {}): Pair => ({
  key: nextKey++,
  name: '',
  value: '',
  secret: false,
  saved: false,
  ...p,
})

export function pairsOf(server: McpServer | undefined, section: 'env' | 'headers'): Pair[] {
  const items = server?.[section] ?? []
  return items.map((kv) =>
    pair({ name: kv.name, value: kv.value ?? '', secret: kv.secret, saved: kv.secret && kv.hasValue }),
  )
}

/** The rows to send: named ones, leaving out a stored secret whose value was left empty (kept as is). */
export function toInput(pairs: Pair[]): McpKeyValueInput[] {
  return pairs
    .filter((p) => p.name.trim())
    .map((p) => ({
      name: p.name.trim(),
      secret: p.secret,
      ...(p.secret && p.saved && p.value === '' ? {} : { value: p.value }),
    }))
}
