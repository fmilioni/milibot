import { timingSafeEqual } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

export function tokenMatches(expected: string | null, header: string | undefined): boolean {
  if (!expected || !header) return false
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
  if (!match?.[1]) return false
  const a = Buffer.from(match[1])
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

// The token file is written by cloud-init, possibly after the agent starts, so it is re-read when it changes.
export class TokenSource {
  private cached: string | null = null
  private mtimeMs = -1

  constructor(private readonly file: string) {}

  get(): string | null {
    try {
      const st = statSync(this.file)
      if (st.mtimeMs !== this.mtimeMs) {
        const value = readFileSync(this.file, 'utf8').trim()
        this.cached = value.length >= 16 ? value : null
        this.mtimeMs = st.mtimeMs
      }
    } catch {
      this.cached = null
      this.mtimeMs = -1
    }
    return this.cached
  }
}
