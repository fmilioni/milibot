import * as fs from 'node:fs'
import { dirname } from 'node:path'

export const AGENT_HOME = '/home/agent'
export const CLAUDE_SETTINGS = `${AGENT_HOME}/.claude/settings.json`
const DEFAULTS = { outputStyle: 'Concise' } as const

interface Owner {
  uid: number
  gid: number
}

export interface SettingsFs {
  read(path: string): string | null
  owner(path: string): Owner | null
  /** Creates the directory (0700) owned by `owner` when it does not exist. */
  mkdir(path: string, owner: Owner): void
  /** Writes through a temporary file + rename, 0600, owned by `owner`. */
  write(path: string, content: string, owner: Owner): void
}

const nodeSettingsFs: SettingsFs = {
  read(path) {
    try {
      return fs.readFileSync(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  },
  owner(path) {
    try {
      const st = fs.statSync(path)
      return { uid: st.uid, gid: st.gid }
    } catch {
      return null
    }
  },
  mkdir(path, owner) {
    if (fs.existsSync(path)) return
    fs.mkdirSync(path, { mode: 0o700 })
    fs.chownSync(path, owner.uid, owner.gid)
  },
  write(path, content, owner) {
    const tmp = `${path}.milibot-new`
    fs.writeFileSync(tmp, content, { mode: 0o600 })
    fs.chownSync(tmp, owner.uid, owner.gid)
    fs.renameSync(tmp, path)
  },
}

export type SettingsResult = 'written' | 'unchanged' | 'no_agent' | 'invalid'

/**
 * Global Claude Code settings of `agent` (every Claude Code process in the VM runs as agent). Adds the
 * defaults the user has not set, keeping everything else, including a value changed by hand in the VM.
 * Idempotent; runs at every agent start, so the login's fresh `~/.claude` gets it on the next boot.
 */
export function ensureClaudeSettings(
  io: SettingsFs = nodeSettingsFs,
  path = CLAUDE_SETTINGS,
): SettingsResult {
  const owner = io.owner(AGENT_HOME)
  if (!owner) return 'no_agent'
  const raw = io.read(path)
  let settings: Record<string, unknown> = {}
  if (raw !== null && raw.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'invalid'
      settings = parsed as Record<string, unknown>
    } catch {
      return 'invalid'
    }
  }
  const missing = Object.entries(DEFAULTS).filter(([key]) => !(key in settings))
  if (!missing.length) return 'unchanged'
  io.mkdir(dirname(path), owner)
  io.write(path, `${JSON.stringify({ ...settings, ...Object.fromEntries(missing) }, null, 2)}\n`, owner)
  return 'written'
}
