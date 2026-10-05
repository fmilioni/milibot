/** Names of headers, variables, flags and query parameters that carry credentials. */
export const SECRET_NAME =
  /auth|token|secret|key|pass(word|wd)?|pwd|cookie|credential|session|bearer|signature/i

/** Flags named after a credential that take a reference to one (a file, a variable), not the value itself. */
const REFERENCE_FLAG =
  /[-_](file|path|dir|directory|env|var|name|id|type|mode|method|url|uri|endpoint|header|helper|cmd|command|store|storage)$/i

/** Values that are settings, not credentials (`--auth none`, `?session=true`). */
const SETTING_VALUE =
  /^(true|false|yes|no|none|null|on|off|0|1|auto|required|optional|bearer|basic|oauth2?|header|query|env)$/i

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
const HEADER_LINE = /^([A-Za-z][\w-]*):\s*(.+)$/s

/** A literal credential: not empty, not a setting, a path or a variable to be expanded (`$TOKEN`). */
function literal(value: string): boolean {
  const v = value
    .trim()
    .replace(/^(bearer|basic|token)\s+/i, '')
    .trim()
  if (!v || SETTING_VALUE.test(v)) return false
  if (/^(\/|\.{1,2}\/|~\/|[A-Za-z]:\\)/.test(v)) return false
  return !/^(\$\{?[A-Za-z_]\w*\}?|%[A-Za-z_]\w*%)$/.test(v)
}

function inUrl(text: string): string | null {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.username || url.password) return 'a user and password in the address (user:password@host)'
  const params = [...url.searchParams, ...new URLSearchParams(url.hash.slice(1))]
  const found = params.find(([name, value]) => SECRET_NAME.test(name) && literal(value))
  return found ? `the query parameter "${found[0]}"` : null
}

/**
 * What in `parts` (a url, a command or its arguments, in order) looks like a credential written as text,
 * by the same naming rule as headers and env, or null. A flag followed by its value in the next part
 * (`--token X`) counts as `--token=X`.
 */
export function credentialInText(parts: string[]): string | null {
  for (const [i, part] of parts.entries()) {
    if (KNOWN_TOKEN.test(part)) return 'a value in the format of an API key or token'
    if (URL_START.test(part)) {
      const found = inUrl(part)
      if (found) return found
      continue
    }
    const flag = FLAG.exec(part)
    if (flag) {
      const name = flag[1] as string
      if (!SECRET_NAME.test(name) || REFERENCE_FLAG.test(name)) continue
      const value = flag[2] ?? parts[i + 1]
      if (value !== undefined && (flag[2] !== undefined || !value.startsWith('-')) && literal(value))
        return `the flag "--${name}"`
      continue
    }
    const pair = ASSIGNMENT.exec(part) ?? HEADER_LINE.exec(part)
    if (pair && SECRET_NAME.test(pair[1] as string) && literal(pair[2] as string)) return `"${pair[1]}"`
  }
  return null
}
