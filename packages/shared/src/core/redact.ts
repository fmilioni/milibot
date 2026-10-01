export const REDACTED = '••••••'
/** Shorter values would redact ordinary words and numbers. */
const MIN_SECRET_LENGTH = 6

/** Replaces every occurrence of the secret values inside strings of `value` (deep copy). */
export function redactSecrets<T>(value: T, secrets: Iterable<string>): T {
  const list = [...new Set([...secrets].filter((s) => s.length >= MIN_SECRET_LENGTH))].sort(
    (a, b) => b.length - a.length,
  )
  if (list.length === 0) return value
  const redactString = (text: string) => {
    let out = text
    for (const secret of list) if (out.includes(secret)) out = out.split(secret).join(REDACTED)
    return out
  }
  const visit = (node: unknown): unknown => {
    if (typeof node === 'string') return redactString(node)
    if (Array.isArray(node)) return node.map(visit)
    if (node && typeof node === 'object' && Object.getPrototypeOf(node) === Object.prototype) {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, visit(v)]))
    }
    return node
  }
  return visit(value) as T
}
