// Process identity for pid files: after a reboot the pid in `qemu.pid` or `gvproxy.pid` can belong to an
// unrelated process.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** Whether a process with this pid exists (it may belong to another user, or be a reused pid). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** `ps -o comm=` output (a path on macOS, a name cut at 15 characters on Linux). */
export function parsePsComm(stdout: string): string | null {
  const line = stdout.trim().split('\n')[0]?.trim()
  return line ? path.posix.basename(line) : null
}

/** First image name of `tasklist /FO CSV /NH` output; its "no tasks" notice is localized and has no quotes. */
export function parseTasklistCsv(stdout: string): string | null {
  const match = /^"([^"]+)"/m.exec(stdout)
  return match?.[1] ?? null
}

export function isQemuImage(name: string): boolean {
  return /^qemu-system-/i.test(name)
}

export function isGvproxyImage(name: string): boolean {
  return /^gvproxy(\.exe)?$/i.test(name)
}

/** Executable name of a running pid, or null when it can't be read. */
function processImage(pid: number, platform: string = process.platform): string | null {
  try {
    if (platform === 'linux') return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() || null
    if (platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
      })
      return parseTasklistCsv(out)
    }
    return parsePsComm(
      execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', windowsHide: true }),
    )
  } catch {
    return null
  }
}

export type ProcessIdentity = 'yes' | 'no' | 'unknown'

/**
 * Whether `pid` runs a program whose name `matches`: 'yes', 'no' (gone, or reused by another program) or
 * 'unknown' (alive but its name can't be read; treated as running so a live VM is never started twice).
 */
function processIdentity(pid: number, matches: (image: string) => boolean): ProcessIdentity {
  if (!pidAlive(pid)) return 'no'
  const image = processImage(pid)
  if (image === null) return pidAlive(pid) ? 'unknown' : 'no'
  return matches(image) ? 'yes' : 'no'
}

export const qemuIdentity = (pid: number): ProcessIdentity => processIdentity(pid, isQemuImage)

export const gvproxyIdentity = (pid: number): ProcessIdentity => processIdentity(pid, isGvproxyImage)

/** The pid in a pid file, or null when the file is missing or holds no pid. */
export function readPidFile(file: string): number | null {
  let pid: number
  try {
    pid = Number(fs.readFileSync(file, 'utf8').trim())
  } catch {
    return null
  }
  return Number.isInteger(pid) && pid > 0 ? pid : null
}
