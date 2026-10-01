/** `items` with `item` replacing the one with its id, or appended. */
export function upsertById<T extends { id: string }>(items: readonly T[], item: T): T[] {
  return items.some((i) => i.id === item.id)
    ? items.map((i) => (i.id === item.id ? item : i))
    : [...items, item]
}

export function removeById<T extends { id: string }>(items: readonly T[], id: string): T[] {
  return items.filter((i) => i.id !== id)
}
