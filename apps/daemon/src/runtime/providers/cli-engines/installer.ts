import type { CliInstallStatus, LogFn } from '@milibot/shared'

import { errorMessage } from '../../../errors'
import { type GuestClient, onVmTransition, type VmController } from '../../vm'
import type { CliInstaller } from './host'

/** A CLI Milibot installs in the VM itself (engines with `needsInstall`). */
export interface VmCliSpec {
  /** In errors and logs ("Codex"). */
  displayName: string
  /** Version shown in the settings and required before a process starts. */
  expected: string
  /** Install script, run as root; prints what `parse` reads, and `installedMarker` when it installed. */
  script: string
  env: Record<string, string>
  stdin?: string
  installedMarker: string
  /** Run as agent: prints what `parse` reads. */
  versionCommand: string
  /** The version the output shows when the install is current (an outdated part reads as null). */
  parse(stdout: string): string | null
}

export interface VmCliInstallerDeps {
  vm: Pick<VmController, 'status' | 'subscribe' | 'runningGuest'>
  /** Whether any provider of the workspace runs on this engine. */
  needed: () => boolean
  log: LogFn
}

/**
 * A CLI in the VM: installed (or updated to `expected`) on demand, when a provider of its engine exists and the
 * VM is running. One install at a time; the last failure is kept for the settings.
 */
export class VmCliInstaller implements CliInstaller {
  private installing: Promise<CliInstallStatus> | null = null
  private error: string | null = null
  private version: string | null = null
  private unsubscribe: (() => void) | null = null

  constructor(
    private readonly spec: VmCliSpec,
    private readonly deps: VmCliInstallerDeps,
  ) {}

  /** Installs when the VM comes up with a provider of the engine configured. */
  start(): void {
    this.unsubscribe = onVmTransition(this.deps.vm, {
      up: () => void this.ensure(),
      down: () => {
        this.version = null
      },
    })
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /** Before a process of the engine starts: installs (or waits for the install) when needed; throws when it failed. */
  async ready(): Promise<void> {
    if (this.version === this.spec.expected && !this.installing) return
    const status = await this.install()
    if (status.version !== this.spec.expected)
      throw new Error(
        `${this.spec.displayName} could not be installed in the VM${status.error ? `: ${status.error}` : ''}`,
      )
  }

  /** Installs in the background when needed and not done yet; never rejects. */
  async ensure(): Promise<void> {
    if (!this.deps.needed() || this.deps.vm.status().state !== 'running') return
    if (this.version === this.spec.expected) return
    await this.install().catch(() => undefined)
  }

  async status(): Promise<CliInstallStatus> {
    if (!this.installing && this.deps.vm.status().state === 'running' && this.version === null) {
      this.version = await this.readVersion(this.deps.vm.runningGuest()).catch(() => null)
    }
    return {
      version: this.version,
      expected: this.spec.expected,
      installing: this.installing !== null,
      error: this.error,
    }
  }

  install(): Promise<CliInstallStatus> {
    this.installing ??= this.run().finally(() => {
      this.installing = null
    })
    return this.installing
  }

  private async run(): Promise<CliInstallStatus> {
    if (this.deps.vm.status().state !== 'running') {
      this.error = 'The workspace VM is not running'
      return this.snapshot()
    }
    try {
      const result = await this.deps.vm.runningGuest().exec({
        user: 'root',
        cmd: this.spec.script,
        cwd: '/',
        env: this.spec.env,
        ...(this.spec.stdin === undefined ? {} : { stdin: this.spec.stdin }),
        timeoutMs: 10 * 60_000,
      })
      if (result.code !== 0) throw new Error(result.stderr.trim().slice(-1500) || `exit code ${result.code}`)
      this.version = this.spec.parse(result.stdout)
      this.error = null
      if (result.stdout.includes(this.spec.installedMarker))
        this.deps.log('info', `${this.spec.displayName} installed in the VM`, { version: this.version })
    } catch (err) {
      this.error = errorMessage(err)
      this.deps.log('warn', `${this.spec.displayName} install failed`, { err: this.error })
    }
    return this.snapshot()
  }

  private snapshot(): CliInstallStatus {
    return { version: this.version, expected: this.spec.expected, installing: false, error: this.error }
  }

  private async readVersion(guest: Pick<GuestClient, 'exec'>): Promise<string | null> {
    const result = await guest.exec({ user: 'agent', cmd: this.spec.versionCommand, timeoutMs: 20_000 })
    return result.code === 0 ? this.spec.parse(result.stdout) : null
  }
}
