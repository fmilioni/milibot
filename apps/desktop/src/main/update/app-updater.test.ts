import { EventEmitter } from 'node:events'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppUpdateState } from '../../bridge/contract'
import { AppUpdateService, CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, type UpdaterEngine } from './app-updater'

class FakeEngine extends EventEmitter {
  autoDownload = false
  autoInstallOnAppQuit = false
  allowPrerelease = true
  checkForUpdates = vi.fn(() => Promise.resolve(null))
  quitAndInstall = vi.fn()
}

function setup(options: { engine?: FakeEngine | null } = {}) {
  const engine = options.engine === undefined ? new FakeEngine() : options.engine
  const states: AppUpdateState[] = []
  const deps = {
    engine: engine as unknown as UpdaterEngine | null,
    beforeInstall: vi.fn(() => Promise.resolve()),
    installFailed: vi.fn(),
    log: vi.fn(),
  }
  const service = new AppUpdateService(deps)
  service.onChange((state) => states.push(state))
  return { service, engine, deps, states }
}

/** What electron-updater emits while it checks and downloads `version`. */
function downloads(engine: FakeEngine, version: string) {
  engine.emit('checking-for-update')
  engine.emit('update-available', { version })
  engine.emit('download-progress', { percent: 42.7 })
  engine.emit('update-downloaded', { version })
}

describe('AppUpdateService', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('stays disabled and never checks without an updater', async () => {
    const { service } = setup({ engine: null })
    service.start()
    expect(service.state).toEqual({ status: 'disabled' })
    expect(await service.install()).toBe(false)
  })

  it('downloads in the background and checks only for releases', () => {
    const { service, engine } = setup()
    service.start()
    expect(engine).toMatchObject({ autoDownload: true, autoInstallOnAppQuit: true, allowPrerelease: false })
  })

  it('checks shortly after launch and then on an interval', async () => {
    const { service, engine } = setup()
    service.start()
    expect(engine?.checkForUpdates).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS)
    expect(engine?.checkForUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(engine?.checkForUpdates).toHaveBeenCalledTimes(2)
    service.stop()
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(engine?.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('follows a check, the download and the downloaded update', () => {
    const { service, engine, states } = setup()
    service.start()
    downloads(engine!, '0.5.0')
    expect(states).toEqual([
      { status: 'checking' },
      { status: 'downloading', version: '0.5.0', percent: 0 },
      { status: 'downloading', version: '0.5.0', percent: 42 },
      { status: 'ready', version: '0.5.0' },
    ])
  })

  it('goes back to idle when there is nothing new', () => {
    const { service, engine } = setup()
    service.start()
    engine!.emit('checking-for-update')
    engine!.emit('update-not-available', { version: '0.4.0' })
    expect(service.state).toEqual({ status: 'idle' })
  })

  it('keeps a failed check quiet and tries again on the next one', async () => {
    const { service, engine, deps } = setup()
    engine!.checkForUpdates.mockImplementationOnce(() => {
      engine!.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'))
      return Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED'))
    })
    service.start()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS)
    expect(service.state).toEqual({ status: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' })
    expect(deps.log).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(engine?.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('does not check again while an update is downloading or waits to be installed', async () => {
    const { service, engine } = setup()
    service.start()
    engine!.emit('update-available', { version: '0.5.0' })
    await service.check()
    engine!.emit('update-downloaded', { version: '0.5.0' })
    await service.check()
    expect(engine?.checkForUpdates).not.toHaveBeenCalled()
  })

  it('keeps a downloaded update when a later event or error arrives', () => {
    const { service, engine } = setup()
    service.start()
    downloads(engine!, '0.5.0')
    engine!.emit('checking-for-update')
    engine!.emit('update-not-available', { version: '0.5.0' })
    engine!.emit('error', new Error('late'))
    expect(service.state).toEqual({ status: 'ready', version: '0.5.0' })
  })

  it('installs only a downloaded update, after getting the app ready to quit', async () => {
    const { service, engine, deps } = setup()
    service.start()
    expect(await service.install()).toBe(false)
    expect(engine?.quitAndInstall).not.toHaveBeenCalled()

    downloads(engine!, '0.5.0')
    const order: string[] = []
    deps.beforeInstall.mockImplementation(() => {
      order.push('beforeInstall')
      return Promise.resolve()
    })
    engine!.quitAndInstall.mockImplementation(() => order.push('quitAndInstall'))
    expect(await service.install()).toBe(true)
    expect(order).toEqual(['beforeInstall', 'quitAndInstall'])
    expect(engine?.quitAndInstall).toHaveBeenCalledWith(true, true)
    expect(service.state).toEqual({ status: 'installing', version: '0.5.0' })
    expect(await service.install()).toBe(false)
  })

  it('offers the update again when the installer refuses to start', async () => {
    const { service, engine, deps } = setup()
    service.start()
    downloads(engine!, '0.5.0')
    engine!.quitAndInstall.mockImplementation(() => engine!.emit('error', new Error('pkexec cancelled')))
    expect(await service.install()).toBe(false)
    expect(service.state).toEqual({ status: 'ready', version: '0.5.0' })
    expect(deps.installFailed).toHaveBeenCalledTimes(1)
  })

  it('offers the update again when getting ready to quit fails', async () => {
    const { service, engine, deps } = setup()
    service.start()
    downloads(engine!, '0.5.0')
    deps.beforeInstall.mockRejectedValue(new Error('boom'))
    expect(await service.install()).toBe(false)
    expect(engine?.quitAndInstall).not.toHaveBeenCalled()
    expect(service.state).toEqual({ status: 'ready', version: '0.5.0' })
    expect(deps.installFailed).toHaveBeenCalledTimes(1)
  })
})
