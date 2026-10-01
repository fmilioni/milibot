import type { GuestOfficePhase, GuestOfficeStatus } from '@milibot/shared/portable/guest-api'

import {
  aptGet,
  type AptStatusLine,
  type CommandResult,
  type CommandRunner,
  hasAptLists,
  parseAptStatus,
  runRootCommand,
  withAptLock,
} from '../apt.ts'
import { findBinary } from './tools.ts'

/** Headless LibreOffice (no X11/GTK). */
const OFFICE_PACKAGES = ['libreoffice-writer-nogui', 'libreoffice-calc-nogui', 'libreoffice-impress-nogui']

/** Share of the whole install: `apt-get update` (only when needed), download, then unpack/configure. */
const PHASE_RANGE: Record<Exclude<GuestOfficePhase, 'removing'>, [number, number]> = {
  preparing: [0, 0.1],
  downloading: [0.1, 0.5],
  installing: [0.5, 1],
}

export function installProgress(phase: GuestOfficePhase, percent: number): number {
  if (phase === 'removing') return percent / 100
  const [from, to] = PHASE_RANGE[phase]
  return Math.round((from + ((to - from) * percent) / 100) * 1000) / 1000
}

const tail = (result: CommandResult) => result.output.trim().split('\n').slice(-8).join('\n').slice(-800)

export interface OfficeInstaller {
  status(): GuestOfficeStatus
  /** Starts (or queues after a running removal) the install; returns at once. */
  install(): GuestOfficeStatus
  /** Purges the packages (and the dependencies only they needed), then trims the disk. */
  remove(): GuestOfficeStatus
  /** Settles when nothing is queued or running (tests). */
  idle(): Promise<void>
}

/**
 * LibreOffice for the old binary Office formats and ODF sheets/slides. Opt-in per workspace (it is large), so
 * only the daemon asks for it; an extraction never installs it. One operation at a time, the last request wins
 * (on → off → on while installing ends installed).
 */
export function createOfficeInstaller(
  deps: { run?: CommandRunner; installed?: () => boolean; hasLists?: () => boolean } = {},
): OfficeInstaller {
  const run = deps.run ?? runRootCommand
  const installed = deps.installed ?? (() => findBinary('soffice') !== null)
  const hasLists = deps.hasLists ?? hasAptLists
  let current: { phase: GuestOfficePhase; progress: number } | null = null
  let error: { message: string; op: 'install' | 'remove' } | null = null
  let desired: 'install' | 'remove' | null = null
  let loop: Promise<void> | null = null

  const status = (): GuestOfficeStatus => {
    const isInstalled = installed()
    if (current) {
      return {
        state: current.phase === 'removing' ? 'removing' : 'installing',
        installed: isInstalled,
        phase: current.phase,
        progress: current.progress,
        error: null,
        failed: null,
      }
    }
    if (error)
      return {
        state: 'error',
        installed: isInstalled,
        phase: null,
        progress: null,
        error: error.message,
        failed: error.op,
      }
    return {
      state: isInstalled ? 'installed' : 'absent',
      installed: isInstalled,
      phase: null,
      progress: null,
      error: null,
      failed: null,
    }
  }

  const step = (phase: GuestOfficePhase, percent = 0) => {
    const progress = installProgress(phase, percent)
    // apt reports each phase from 0 again; the bar never goes back.
    current = {
      phase,
      progress: current && current.phase === phase ? Math.max(current.progress, progress) : progress,
    }
  }

  const apt = (args: string[], phaseOf: (line: AptStatusLine) => GuestOfficePhase | null) =>
    aptGet(run, args, (raw) => {
      const line = parseAptStatus(raw)
      if (!line || line.type === 'pmerror') return
      const phase = phaseOf(line)
      if (phase) step(phase, line.percent)
    })

  const update = async () => {
    step('preparing')
    const result = await apt(['update'], (line) => (line.type === 'dlstatus' ? 'preparing' : null))
    if (result.code !== 0) throw new Error(`apt-get update failed (no network?): ${tail(result)}`)
  }

  const doInstall = async () => {
    step('preparing')
    // A VM stopped in the middle of a previous run leaves dpkg half done.
    await run('dpkg', ['--configure', '-a'])
    let updated = false
    if (!hasLists()) {
      await update()
      updated = true
    }
    const aptInstall = () =>
      apt(['install', '-y', '--no-install-recommends', ...OFFICE_PACKAGES], (line) =>
        line.type === 'dlstatus' ? 'downloading' : 'installing',
      )
    let result = await aptInstall()
    if (result.code !== 0 && !updated) {
      // Stale package lists (a golden image built weeks ago) point to versions the mirror no longer has.
      await update()
      result = await aptInstall()
    }
    if (result.code !== 0) throw new Error(`apt-get install failed: ${tail(result)}`)
    await run('apt-get', ['clean'])
    if (!installed()) throw new Error('soffice is missing after the install')
  }

  const doRemove = async () => {
    step('removing')
    const result = await apt(['purge', '-y', '--autoremove', ...OFFICE_PACKAGES], (line) =>
      line.type === 'pmstatus' ? 'removing' : null,
    )
    if (result.code !== 0) throw new Error(`apt-get purge failed: ${tail(result)}`)
    // The disks are attached with discard=unmap: trimming gives the freed space back to the host.
    await run('fstrim', ['/'])
  }

  const drive = async () => {
    while (desired) {
      const op: 'install' | 'remove' = desired
      desired = null
      if ((op === 'install') === installed()) continue
      error = null
      try {
        await withAptLock(op === 'install' ? doInstall : doRemove)
      } catch (err) {
        error = { message: (err as Error).message, op }
      } finally {
        current = null
      }
    }
  }

  const request = (op: 'install' | 'remove'): GuestOfficeStatus => {
    desired = op
    if (!loop) {
      error = null
      // Shown as running right away, so a poll right after the request never reads a stale state.
      if ((op === 'install') !== installed()) step(op === 'install' ? 'preparing' : 'removing')
      // Cleared asynchronously: drive() may finish before this assignment when there is nothing to do.
      loop = drive().finally(() => {
        loop = null
      })
    }
    return status()
  }

  return {
    status,
    install: () => request('install'),
    remove: () => request('remove'),
    idle: async () => {
      while (loop) await loop
    },
  }
}
