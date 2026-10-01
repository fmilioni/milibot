import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import type { Readable } from 'node:stream'

import { OutputTail } from './spawn.ts'

const APT_ENV = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', DEBIAN_FRONTEND: 'noninteractive', LANG: 'C.UTF-8' }
const RUN_TIMEOUT_MS = 20 * 60_000

export interface CommandResult {
  code: number | null
  /** Tail of stdout + stderr. */
  output: string
}

/** Runs a command as root; `onStatus` receives the lines apt writes to fd 3. */
export type CommandRunner = (
  file: string,
  args: string[],
  onStatus?: (line: string) => void,
) => Promise<CommandResult>

export const runRootCommand: CommandRunner = (file, args, onStatus) =>
  new Promise((resolve) => {
    const child = spawn(file, args, {
      stdio: ['ignore', 'pipe', 'pipe', onStatus ? 'pipe' : 'ignore'],
      env: APT_ENV,
    })
    const output = new OutputTail(8000)
    child.stdout?.on('data', output.push)
    child.stderr?.on('data', output.push)
    if (onStatus) {
      let pending = ''
      ;(child.stdio[3] as Readable | null)?.on('data', (chunk: Buffer) => {
        pending += chunk.toString('utf8')
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) onStatus(line)
      })
    }
    const timer = setTimeout(() => child.kill('SIGTERM'), RUN_TIMEOUT_MS)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: null, output: err.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, output: output.text })
    })
  })

/** `apt-get` waiting up to 5 min for the dpkg lock; with `onStatus`, progress lines come on fd 3. */
export function aptGet(
  run: CommandRunner,
  args: string[],
  onStatus?: (line: string) => void,
): Promise<CommandResult> {
  const status = onStatus ? ['-o', 'APT::Status-Fd=3'] : []
  return run('apt-get', ['-o', 'DPkg::Lock::Timeout=300', ...status, ...args], onStatus)
}

let aptQueue: Promise<unknown> = Promise.resolve()

/** One apt/dpkg run at a time in this process (the extraction tools and LibreOffice install separately). */
export function withAptLock<T>(work: () => Promise<T>): Promise<T> {
  const run = aptQueue.then(work, work)
  aptQueue = run.catch(() => undefined)
  return run
}

export function hasAptLists(): boolean {
  try {
    return readdirSync('/var/lib/apt/lists').some((name) => name.endsWith('_Packages'))
  } catch {
    return false
  }
}

export interface AptStatusLine {
  type: 'dlstatus' | 'pmstatus' | 'pmerror'
  /** 0..100 */
  percent: number
  message: string
}

/** One line of apt's `APT::Status-Fd` (`dlstatus:<n>:<percent>:<msg>`, `pmstatus:<pkg[:arch]>:<percent>:<msg>`). */
export function parseAptStatus(line: string): AptStatusLine | null {
  const match = /^(dlstatus|pmstatus|pmerror):(.*?):(\d+(?:\.\d+)?):(.*)$/.exec(line.trim())
  if (!match) return null
  const percent = Math.max(0, Math.min(100, Number(match[3])))
  return { type: match[1] as AptStatusLine['type'], percent, message: match[4]!.trim() }
}
