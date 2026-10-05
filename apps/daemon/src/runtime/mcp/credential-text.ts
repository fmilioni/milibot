/**
 * A word that names a credential. Only the last word of a name decides (`--token-file`, `--api-key-env`,
 * `--max-tokens`, `TOKEN_URL` name something else), and whole words only (`--keyword`, `--author`).
 */
const CREDENTIAL_WORD = new RegExp(
  '^(' +
    [
      '[a-z]*(token|secret|password|passwd|passphrase|credentials?)',
      '(api|access|secret|private|client|master|license|licence|app|auth|signing|encryption|service|account|subscription|consumer|admin)?key',
      'auth|authorization|bearer|cookie|session|sessionid|pwd|pass|pat|creds|sig|signature|jwt',
    ].join('|') +
    ')$',
  'i',
)

/** Values that are settings, not credentials (`--auth none`, `?session=true`). */
const SETTING_VALUE =
  /^(true|false|yes|no|none|null|on|off|0|1|auto|default|required|optional|bearer|basic|oauth2?|header|query|env)$/i

/** Formats of well-known API keys and tokens, recognized whatever name they come under. */
const KNOWN_TOKEN = new RegExp(
  [
    'sk-[A-Za-z0-9_-]{20,}',
    '[rsp]k_(live|test)_[A-Za-z0-9]{16,}',
    'gh[pousr]_[A-Za-z0-9]{30,}',
    'github_pat_[A-Za-z0-9_]{20,}',
    'glpat-[A-Za-z0-9_-]{20,}',
    'xox[abposr]-[A-Za-z0-9-]{10,}',
    'AKIA[0-9A-Z]{16}',
    'AIza[0-9A-Za-z_-]{35}',
    'eyJ[\\w-]{10,}\\.eyJ[\\w-]{10,}\\.[\\w-]{10,}',
  ]
    .map((p) => `(?<![A-Za-z0-9])${p}`)
    .join('|'),
)

const URL_START = /^[a-z][a-z0-9+.-]*:\/\//i
const ASSIGNMENT = /^([A-Za-z_][\w.-]*)=(.*)$/s
const FLAG = /^--?([A-Za-z][\w.-]*)(?:=(.*))?$/s
const HEADER_LINE = /^([A-Za-z][\w-]*):(?!\/\/)\s*(.*)$/s

/** Whether a header, variable, flag or query parameter name is one that carries a credential. */
export function credentialName(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
  const last = words.at(-1)
  return last !== undefined && CREDENTIAL_WORD.test(last)
}

/** A literal credential: not empty, not a setting, a path or a variable to be expanded (`$TOKEN`). */
export function literal(value: string): boolean {
  const v = unquote(value)
    .replace(/^(bearer|basic|token)\s+/i, '')
    .trim()
  if (!v || SETTING_VALUE.test(v)) return false
  if (/^(\/|\.{1,2}\/|~\/|[A-Za-z]:\\)/.test(v)) return false
  return !/^(\$\{?[A-Za-z_]\w*\}?|%[A-Za-z_]\w*%)$/.test(v)
}

/** Whether `text` holds a value in the format of a well-known API key or token. */
export function knownToken(text: string): boolean {
  return KNOWN_TOKEN.test(text)
}

function unquote(value: string): string {
  return value
    .trim()
    .replace(/^(["'])(.*)\1$/s, '$2')
    .replace(/^["']|["']$/g, '')
}

function inUrl(text: string): string | null {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.username || url.password) return 'a user and password in the address (user:password@host)'
  for (const [name, value] of [...url.searchParams, ...new URLSearchParams(url.hash.slice(1))]) {
    if (credentialName(name) && literal(value)) return `the query parameter "${name}"`
    const nested = URL_START.test(value) ? inUrl(value) : null
    if (nested) return nested
  }
  return null
}

/** One part, with the parts after it (a flag's or a header line's value may come next). */
function inPart(raw: string, rest: string[]): string | null {
  const part = unquote(raw)
  if (KNOWN_TOKEN.test(part)) return 'a value in the format of an API key or token'
  if (URL_START.test(part)) return inUrl(part)
  const flag = FLAG.exec(part)
  if (flag) {
    const name = flag[1] as string
    const value = flag[2]
    if (value === undefined) {
      const next = rest[0]
      const takes = next !== undefined && !next.startsWith('-')
      return credentialName(name) && takes && literal(next) ? `the flag "--${name}"` : null
    }
    if (credentialName(name) && literal(value)) return `the flag "--${name}"`
    return inPart(value, rest)
  }
  const pair = ASSIGNMENT.exec(part) ?? HEADER_LINE.exec(part)
  if (!pair) return null
  const name = pair[1] as string
  const value = pair[2] || (part.endsWith(':') ? rest.join(' ') : '')
  if (credentialName(name) && literal(value)) return `"${name}"`
  return pair[2] ? inPart(pair[2], []) : null
}

/**
 * What in `parts` (a url, a command or its arguments, in order) looks like a credential written as text, or
 * null: a value under a credential's name (query parameter, flag, `NAME=value`, `Name: value`), whatever
 * nests in a flag's value (`--header=Authorization: Bearer X`, `--env=API_KEY=X`), and, whatever the name,
 * a user and password in an address or a well-known key format. A flag followed by its value in the next
 * part (`--token X`) counts as `--token=X`.
 */
export function credentialInText(parts: string[]): string | null {
  for (const [i, part] of parts.entries()) {
    const found = inPart(part, parts.slice(i + 1))
    if (found) return found
  }
  return null
}
