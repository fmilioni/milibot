import type { Bot, McpServer } from '@milibot/shared'

/** Splits a command line like a POSIX shell would (quotes and backslashes), without expansions. */
export function splitCommandLine(text: string): string[] {
  const words: string[] = []
  let current = ''
  let inWord = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string
    if (quote === "'") {
      if (char === "'") quote = null
      else current += char
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = null
      else if (char === '\\' && i + 1 < text.length && '"\\$`'.includes(text[i + 1] as string))
        current += text[++i]
      else current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      inWord = true
    } else if (char === '\\' && i + 1 < text.length) {
      current += text[++i]
      inWord = true
    } else if (/\s/.test(char)) {
      if (inWord) words.push(current)
      current = ''
      inWord = false
    } else {
      current += char
      inWord = true
    }
  }
  if (inWord) words.push(current)
  return words
}

const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/

/** Inverse of `splitCommandLine`: quotes only the words that need it. */
export function joinCommandLine(words: string[]): string {
  return words.map((w) => (w && SAFE_WORD.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)).join(' ')
}

export function serverDetail(server: Pick<McpServer, 'transport' | 'command' | 'args' | 'url'>): string {
  return server.transport === 'http'
    ? (server.url ?? '')
    : joinCommandLine([server.command ?? '', ...server.args].filter(Boolean))
}

/** Bots listed as "used by": everyone allowed, minus deleted bots. */
export function allowedBotNames(
  allowed: McpServer['allowedBots'],
  bots: Record<string, Bot>,
): string[] | 'all' {
  if (allowed === 'all') return 'all'
  return allowed.flatMap((id) => (bots[id] ? [bots[id].name] : []))
}

export type ServerIconKind = 'github' | 'database' | 'globe' | 'terminal'

export function serverIconKind(
  server: Pick<McpServer, 'name' | 'transport' | 'command' | 'args' | 'url'>,
): ServerIconKind {
  const text =
    `${server.name} ${server.command ?? ''} ${server.args.join(' ')} ${server.url ?? ''}`.toLowerCase()
  if (text.includes('github')) return 'github'
  if (/postgres|mysql|sqlite|mongo|redis|database|\bsql\b|\bdb\b/.test(text)) return 'database'
  return server.transport === 'http' ? 'globe' : 'terminal'
}
