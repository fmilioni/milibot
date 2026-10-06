import type { AppUpdater as ElectronUpdater } from 'electron-updater'

import type { AppUpdateState } from '../../bridge/contract'

/** The first check waits for the app to settle (windows, daemon). */
export const FIRST_CHECK_DELAY_MS = 10_000
export const CHECK_INTERVAL_MS = 4 * 60 * 60_000

/** electron-updater's updater, narrowed to what the service uses. */
export type UpdaterEngine = Pick<
  ElectronUpdater,
  'autoDownload' | 'autoInstallOnAppQuit' | 'allowPrerelease' | 'on' | 'checkForUpdates' | 'quitAndInstall'
>

export interface AppUpdaterDeps {
  /** Null: this build or install cannot update itself. */
  engine: UpdaterEngine | null
  /** Gets the app ready to quit right away (bot screens given back, single-instance lock released). */
  beforeInstall(): Promise<void>
  /** The installer refused to start: the app keeps running, as before `beforeInstall`. */
  installFailed(): void
  log(message: string): void
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * Keeps the app current from its update feed: checks shortly after launch and then periodically, downloads
 * in the background, and installs only when asked (the user's click) or when the app quits anyway. A failed
 * check is only logged; the next one tries again.
 */
export class AppUpdateService {
  private current: AppUpdateState
  private readonly listeners = new Set<(state: AppUpdateState) => void>()
  private timers: Array<ReturnType<typeof setTimeout>> = []

  constructor(private readonly deps: AppUpdaterDeps) {
    this.current = { status: deps.engine ? 'idle' : 'disabled' }
  }

  get state(): AppUpdateState {
    return this.current
  }

  onChange(listener: (state: AppUpdateState) => void): void {
    this.listeners.add(listener)
  }

  start(): void {
    const { engine } = this.deps
    if (!engine || this.timers.length > 0) return
    engine.autoDownload = true
    engine.autoInstallOnAppQuit = true
    engine.allowPrerelease = false
    engine.on('checking-for-update', () => this.whenActive(() => this.set({ status: 'checking' })))
    engine.on('update-not-available', () => this.whenActive(() => this.set({ status: 'idle' })))
    engine.on('update-available', (info) =>
      this.whenActive(() => this.set({ status: 'downloading', version: info.version, percent: 0 })),
    )
    engine.on('download-progress', (progress) =>
      this.whenActive(() => {
        if (this.current.status !== 'downloading') return
        this.set({ ...this.current, percent: Math.max(0, Math.min(100, Math.floor(progress.percent))) })
      }),
    )
    engine.on('update-downloaded', (event) => {
      if (this.current.status === 'installing') return
      this.deps.log(`update ${event.version} downloaded`)
      this.set({ status: 'ready', version: event.version })
    })
    engine.on('error', (err) => this.failed(err))
    this.timers = [
      setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS),
      setInterval(() => void this.check(), CHECK_INTERVAL_MS),
    ]
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
  }

  /** A downloaded update waits to be installed; a newer one is picked up after that. */
  async check(): Promise<void> {
    const { engine } = this.deps
    if (!engine || this.busy()) return
    try {
      await engine.checkForUpdates()
    } catch (err) {
      // Usually already reported through the `error` event.
      if (this.current.status !== 'error') this.failed(err)
    }
  }

  /** Quits and installs the downloaded update; false when none is ready. */
  async install(): Promise<boolean> {
    const { engine } = this.deps
    if (!engine || this.current.status !== 'ready') return false
    const { version } = this.current
    this.set({ status: 'installing', version })
    this.deps.log(`installing ${version}`)
    try {
      await this.deps.beforeInstall()
      // Silent: the Windows installer runs without its wizard; then the new version is started.
      engine.quitAndInstall(true, true)
    } catch (err) {
      this.failed(err)
    }
    // electron-updater reports a refused install through its `error` event, synchronously.
    return this.installing()
  }

  private installing(): boolean {
    return this.current.status === 'installing'
  }

  private busy(): boolean {
    const { status } = this.current
    return status === 'downloading' || status === 'ready' || status === 'installing'
  }

  /** A late event of a check must not hide a downloaded update or one being installed. */
  private whenActive(apply: () => void): void {
    if (this.current.status !== 'ready' && this.current.status !== 'installing') apply()
  }

  private failed(err: unknown): void {
    const message = errorMessage(err)
    this.deps.log(`error: ${message}`)
    if (this.current.status === 'installing') {
      this.set({ status: 'ready', version: this.current.version })
      this.deps.installFailed()
      return
    }
    if (this.current.status === 'ready') return
    this.set({ status: 'error', message })
  }

  private set(state: AppUpdateState): void {
    this.current = state
    for (const listener of this.listeners) listener(state)
  }
}
