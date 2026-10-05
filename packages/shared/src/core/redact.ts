export const REDACTED = '••••••'
/** Shorter values would redact ordinary words and numbers. */
const MIN_SECRET_LENGTH = 6
/** An HTTP auth scheme followed by its credentials, e.g. `Bearer <token>` or `Basic <base64>`. */
const AUTH_SCHEME = /^([A-Za-z][\w.+-]*)\s+(\S+)$/

/**
 * A secret plus the parts a server may echo on their own: the credentials after an auth scheme and,
 * for `Basic`, the decoded `user:password` and the password.
 */
function secretForms(secret: string): string[] {
  const match = AUTH_SCHEME.exec(secret.trim())
  if (!match) return [secret]
  const [, scheme = '', credentials = ''] = match
  const forms = [secret, credentials]
  if (scheme.toLowerCase() === 'basic') {
    const decoded = decodeBase64(credentials)
    const colon = decoded?.indexOf(':') ?? -1
    if (decoded && colon > 0) forms.push(decoded, decoded.slice(colon + 1))
  }
  return forms
}

function decodeBase64(text: string): string | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null
  try {
    const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/** Replaces every occurrence of the secret values inside strings of `value` (deep copy). */
export function redactSecrets<T>(value: T, secrets: Iterable<string>): T {
  const list = [
    ...new Set([...secrets].flatMap(secretForms).filter((s) => s.length >= MIN_SECRET_LENGTH)),
  ].sort((a, b) => b.length - a.length)
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
