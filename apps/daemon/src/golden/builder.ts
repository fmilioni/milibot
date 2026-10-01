import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { GoldenStatus, LogFn } from '@milibot/shared'
import { pidAlive } from '@milibot/vm-host'

import { findRepoFile, scriptCommand, vmRootDir } from '../vm-cli'
import {
  applyBuildOutput,
  buildEtaSeconds,
  buildPercent,
  type BuildProgress,
  INITIAL_BUILD_PROGRESS,
} from './progress'
import { expectedGoldenRevision, goldenRevision } from './revision'

const POLL_MS = 1000

/** `vm/host/src/cli/build-golden.ts`, or `MILIBOT_VM_BUILD` (a fake, the packaged bundle or `vm/build.sh`). */
function defaultBuildScript(override: string | null): string {
  return findRepoFile(join('vm', 'host', 'src', 'cli', 'build-golden.ts'), override, 'MILIBOT_VM_BUILD')
}

export interface GoldenBuilderOptions {
  dataRoot: string
  /** Current golden image (null: missing). */
  golden: () => string | null
  /** The build script (`MILIBOT_VM_BUILD`; default: the repository's); its `vm/` folder holds `golden-revision`. */
  script?: string | null
  env?: NodeJS.ProcessEnv
  /** Extra env for the build decided at build time (e.g. `MILIBOT_VM_ACCEL=tcg`). */
  accelEnv?: () => Record<string, string>
  onStatus: (status: GoldenStatus) => void
  /** A build finished and the image exists. */
  onReady: () => void
  log: LogFn
  now?: () => number
}

interface BuildRecord {
  pid: number
  startedAt: number
}

/**
 * Runs the golden build script detached, with its output in `<dataRoot>/logs/golden-build.log`: closing the
 * app or restarting the daemon does not stop it, and a new daemon adopts it through the pid file.
 */
export class GoldenBuilder {
  private progress: BuildProgress = INITIAL_BUILD_PROGRESS
  private running: BuildRecord | null = null
  private failure: string | null = null
  private offset = 0
  private timer: NodeJS.Timeout | null = null
  private lastEmitted = ''
  private readonly now: () => number

  constructor(private readonly options: GoldenBuilderOptions) {
    this.now = options.now ?? Date.now
  }

  private get logPath(): string {
    return join(this.options.dataRoot, 'logs', 'golden-build.log')
  }

  private get pidPath(): string {
    return join(this.options.dataRoot, 'images', 'golden-build.json')
  }

  private get script(): string {
    return defaultBuildScript(this.options.script ?? null)
  }

  /** Revision this app version builds and the current image's (null: missing). */
  revisions(): { revision: number | null; latestRevision: number } {
    const golden = this.options.golden()
    let latestRevision: number
    try {
      latestRevision = expectedGoldenRevision(vmRootDir(this.script))
    } catch {
      // The build script was not found: a build fails anyway and reports it.
      latestRevision = 1
    }
    return { revision: golden ? goldenRevision(golden) : null, latestRevision }
  }

  status(): GoldenStatus {
    const { revision, latestRevision } = this.revisions()
    const versions = { revision, latestRevision, outdated: revision !== null && revision < latestRevision }
    if (this.running) {
      return {
        state: 'building',
        stage: this.progress.stage,
        percent: buildPercent(this.progress),
        downloadBytes: this.progress.downloadBytes,
        etaSeconds: buildEtaSeconds(this.progress),
        startedAt: this.running.startedAt,
        error: null,
        ...versions,
      }
    }
    const ready = revision !== null
    return {
      state: ready ? 'ready' : this.failure ? 'failed' : 'missing',
      stage: null,
      percent: ready ? 100 : 0,
      downloadBytes: null,
      etaSeconds: null,
      startedAt: null,
      error: ready && !versions.outdated ? null : this.failure,
      ...versions,
    }
  }

  /** Adopts a build left running by a previous daemon. */
  resume(): void {
    let record: BuildRecord | null
    try {
      record = JSON.parse(readFileSync(this.pidPath, 'utf8')) as BuildRecord
    } catch {
      return
    }
    if (!record || !pidAlive(record.pid)) {
      rmSync(this.pidPath, { force: true })
      return
    }
    this.options.log('info', 'adopting golden image build', { pid: record.pid })
    this.running = record
    this.progress = INITIAL_BUILD_PROGRESS
    this.offset = 0
    this.poll()
    this.watch()
  }

  /** Builds the image when it is missing or older than this app version's revision (no-op otherwise). */
  build(): GoldenStatus {
    if (this.running) return this.status()
    const current = this.status()
    if (current.state === 'ready' && !current.outdated) return current
    const script = this.script
    mkdirSync(dirname(this.logPath), { recursive: true })
    mkdirSync(dirname(this.pidPath), { recursive: true })
    const out = openSync(this.logPath, 'w')
    const env: NodeJS.ProcessEnv = {
      ...(this.options.env ?? process.env),
      ...this.options.accelEnv?.(),
      MILIBOT_HOME: this.options.dataRoot,
    }
    const buildDir = env.MILIBOT_BUILD_DIR
    if (buildDir) mkdirSync(buildDir, { recursive: true })
    const { command, args } = scriptCommand(script)
    if (current.outdated) args.push('--rebuild')
    const child = spawn(command, args, {
      env,
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
    })
    closeSync(out)
    if (!child.pid) throw new Error(`could not start ${script}`)
    child.unref()
    const record = { pid: child.pid, startedAt: this.now() }
    writeFileSync(this.pidPath, JSON.stringify(record))
    this.running = record
    this.failure = null
    this.progress = INITIAL_BUILD_PROGRESS
    this.offset = 0
    this.options.log('info', 'golden image build started', { pid: child.pid, buildDir })
    child.on('exit', (code) => this.finish(code))
    this.watch()
    this.emit(true)
    return this.status()
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private watch(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => {
      this.poll()
      if (this.running && !pidAlive(this.running.pid)) this.finish(null)
    }, POLL_MS)
    this.timer.unref()
  }

  private poll(): void {
    let fd: number | null = null
    try {
      fd = openSync(this.logPath, 'r')
      const buffer = Buffer.alloc(64 * 1024)
      for (;;) {
        const read = readSync(fd, buffer, 0, buffer.length, this.offset)
        if (read <= 0) break
        this.offset += read
        this.progress = applyBuildOutput(this.progress, buffer.subarray(0, read).toString('utf8'))
      }
    } catch {
      return
    } finally {
      if (fd !== null) closeSync(fd)
    }
    this.emit(false)
  }

  /** `code` is null when the process was adopted (its exit code is unknown). */
  private finish(code: number | null): void {
    if (!this.running) return
    this.poll()
    this.running = null
    this.close()
    rmSync(this.pidPath, { force: true })
    const { revision, latestRevision } = this.revisions()
    const ready = revision !== null && revision >= latestRevision
    if (ready && (code === 0 || code === null)) {
      this.options.log('info', 'golden image build finished')
      this.emit(true)
      this.options.onReady()
      return
    }
    this.failure =
      this.progress.error ?? (code === null ? 'build interrupted' : `build exited with code ${code}`)
    this.options.log('error', 'golden image build failed', { code, error: this.failure })
    this.emit(true)
  }

  private emit(force: boolean): void {
    const status = this.status()
    const key = JSON.stringify([status.state, status.stage, status.percent, status.etaSeconds, status.error])
    if (!force && key === this.lastEmitted) return
    this.lastEmitted = key
    this.options.onStatus(status)
  }
}
