import * as fs from 'node:fs'
import { dirname } from 'node:path'

import { CLI_WRAPPER } from './guest-files.ts'

export const CLAUDE_BIN = '/usr/local/bin/claude'
export const CLAUDE_REAL = '/usr/local/lib/milibot/claude-real'
const WRAPPER_MARKER = /^# milibot-cli-wrapper$/m

export interface WrapperFs {
  /** Up to `maxBytes` of the file as UTF-8, or null when it does not exist. */
  readHead(path: string, maxBytes: number): string | null
  exists(path: string): boolean
  mkdirp(path: string): void
  link(from: string, to: string): void
  rename(from: string, to: string): void
  unlink(path: string): void
  writeExecutable(path: string, content: string): void
}

const nodeWrapperFs: WrapperFs = {
  readHead(path, maxBytes) {
    let fd: number
    try {
      fd = fs.openSync(path, 'r')
    } catch {
      return null
    }
    try {
      const buf = Buffer.alloc(maxBytes)
      const n = fs.readSync(fd, buf, 0, maxBytes, 0)
      return buf.subarray(0, n).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  },
  exists: (path) => fs.existsSync(path),
  mkdirp: (path) => void fs.mkdirSync(path, { recursive: true, mode: 0o755 }),
  link: (from, to) => fs.linkSync(from, to),
  rename: (from, to) => fs.renameSync(from, to),
  unlink: (path) => fs.rmSync(path, { force: true }),
  writeExecutable(path, content) {
    fs.writeFileSync(path, content, { mode: 0o755 })
    fs.chmodSync(path, 0o755)
  },
}

export type WrapperResult = 'installed' | 'updated' | 'unchanged' | 'no_claude'

/**
 * Puts the wrapper in `/usr/local/bin/claude`, first moving a real binary found there aside (hard link + rename,
 * never a copy or a gap). Idempotent; runs at every agent start.
 */
export function ensureClaudeWrapper(
  io: WrapperFs = nodeWrapperFs,
  paths: { bin: string; real: string } = { bin: CLAUDE_BIN, real: CLAUDE_REAL },
): WrapperResult {
  const writeWrapper = () => {
    const tmp = `${paths.bin}.milibot-new`
    io.writeExecutable(tmp, CLI_WRAPPER)
    io.rename(tmp, paths.bin)
  }

  const current = io.readHead(paths.bin, 64 * 1024)
  if (current === null) {
    if (!io.exists(paths.real)) return 'no_claude'
    writeWrapper()
    return 'installed'
  }
  if (WRAPPER_MARKER.test(current)) {
    if (current === CLI_WRAPPER) return 'unchanged'
    writeWrapper()
    return 'updated'
  }
  // A Claude Code installed over the wrapper becomes the real binary.
  const tmpReal = `${paths.real}.milibot-new`
  io.mkdirp(dirname(paths.real))
  io.unlink(tmpReal)
  io.link(paths.bin, tmpReal)
  io.rename(tmpReal, paths.real)
  writeWrapper()
  return 'installed'
}
