import * as fs from 'node:fs'
import { dirname } from 'node:path'

import cliWrapper from '../../guest/bin/cli-wrapper?raw'
import ghWrapper from '../../guest/bin/gh?raw'
import browserLauncher from '../../guest/bin/milibot-browser?raw'
import desktopSession from '../../guest/bin/milibot-desktop-session?raw'

export interface GuestFile {
  path: string
  content: string
  mode: number
}

/** `/usr/local/bin/claude` and `/usr/local/bin/codex`: every user's CLI runs as `agent`. */
export const CLI_WRAPPER = cliWrapper

/**
 * Helpers the agent owns in every VM, whatever image it was made from; a new agent bundle (swapped in by the
 * daemon when its sha differs) brings their new versions. `claude` goes through `ensureClaudeWrapper`.
 */
export const GUEST_FILES: readonly GuestFile[] = [
  { path: '/usr/local/bin/codex', content: cliWrapper, mode: 0o755 },
  { path: '/usr/local/bin/gh', content: ghWrapper, mode: 0o755 },
  { path: '/usr/local/bin/milibot-browser', content: browserLauncher, mode: 0o755 },
  { path: '/opt/milibot/bin/milibot-desktop-session', content: desktopSession, mode: 0o755 },
]

export type EnsureResult = 'installed' | 'updated' | 'unchanged'

function sameContent(file: string, content: string, size: number): boolean {
  return size === Buffer.byteLength(content) && fs.readFileSync(file, 'utf8') === content
}

/** Puts `content` at `root + path` with `mode` (temporary file + rename) unless it is already there. */
export function ensureGuestFile(file: GuestFile, root = ''): EnsureResult {
  const target = root + file.path
  let st: fs.Stats | null = null
  try {
    st = fs.statSync(target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  if (st?.isFile() && sameContent(target, file.content, st.size)) {
    if ((st.mode & 0o7777) === file.mode) return 'unchanged'
    fs.chmodSync(target, file.mode)
    return 'updated'
  }
  fs.mkdirSync(dirname(target), { recursive: true, mode: 0o755 })
  const tmp = `${target}.milibot-new`
  fs.writeFileSync(tmp, file.content, { mode: file.mode })
  fs.chmodSync(tmp, file.mode)
  fs.renameSync(tmp, target)
  return st ? 'updated' : 'installed'
}
