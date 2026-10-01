import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  type ApiClient,
  createApiClient,
  daemonBaseUrl,
  DaemonInfo,
  DATA_DIR_ENV,
  executableCandidates,
  type HostPlatform,
  isDaemonHealthy,
  searchPath,
} from '@milibot/shared'
import { pidAlive } from '@milibot/vm-host'
import { app } from 'electron'

import type { DaemonConnection } from '../../bridge/contract'
import { type DaemonCommand, daemonEnvironment, packagedDaemon, pathKey } from './command'
import { appPaths, dataRoot } from './paths'
import { shutdownDaemon } from './shutdown'

const HEALTH_TIMEOUT_MS = 1_500
const START_TIMEOUT_MS = 20_000
const EXTERNAL_WAIT_MS = 60_000
const POLL_MS = 250
const STOP_TIMEOUT_MS = 90_000

function usesPackagedDaemon(): boolean {
  return app.isPackaged && !process.env.MILIBOT_DAEMON_ENTRY
}

/**
 * How the daemon is started, shared by the app and the login item. Packaged: the bundled Node and
 * daemon in the app's resources (see `packagedDaemon`). Dev: the TypeScript sources through tsx
 * with the Node on PATH (`MILIBOT_NODE` overrides it), or a built bundle with `MILIBOT_DAEMON_ENTRY`.
 */
export function resolveDaemonCommand(): DaemonCommand {
  const platform = process.platform as HostPlatform
  const dataDir = { [DATA_DIR_ENV]: dataRoot() }

  if (usesPackagedDaemon()) {
    const packaged = packagedDaemon({ platform, resourcesPath: process.resourcesPath, env: process.env })
    return { ...packaged, env: { ...dataDir, ...packaged.env } }
  }

  const host = { platform, env: process.env }
  const node = process.env.MILIBOT_NODE ?? executableCandidates('node', host).find(existsSync) ?? 'node'
  const env = {
    ...dataDir,
    [pathKey(process.env, platform)]: searchPath(host, dirname(node) === '.' ? [] : [dirname(node)]),
  }
  const entry = process.env.MILIBOT_DAEMON_ENTRY
  if (entry) return { command: node, args: [resolve(entry)], env, cwd: dirname(resolve(entry)) }
  const daemonDir = resolve(app.getAppPath(), '..', 'daemon')
  const tsxLoader = pathToFileURL(join(daemonDir, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href
  return {
    command: node,
    args: ['--import', tsxLoader, join(daemonDir, 'src', 'main.ts')],
    env,
    cwd: daemonDir,
  }
}

function toConnection(info: DaemonInfo): DaemonConnection {
  return { baseUrl: daemonBaseUrl(info), token: info.token }
}

/** The detached daemon: found through `daemon.json`, spawned when missing, stopped on request. */
export class DaemonManager {
  private pending: Promise<DaemonInfo> | null = null
  private stopping = false

  /** `MILIBOT_DAEMON_EXTERNAL=1`: the daemon is managed outside the app, which only waits for it. */
  get external(): boolean {
    return process.env.MILIBOT_DAEMON_EXTERNAL === '1'
  }

  get starting(): boolean {
    return this.pending !== null
  }

  /** Returns a healthy daemon, spawning a detached one when none is running. */
  ensure(): Promise<DaemonInfo> {
    if (this.stopping) return Promise.reject(new Error('The background service is stopping'))
    this.pending ??= this.startOrAdopt().finally(() => {
      this.pending = null
    })
    return this.pending
  }

  /**
   * Stops the background service (the "Stop background service" menu item). Resolves to false when it is
   * still running after the timeout; no daemon is spawned again until the app restarts.
   */
  async stop(): Promise<boolean> {
    this.stopping = true
    await this.pending?.catch(() => undefined)
    const info = readInfo()
    const stopped = !info || !pidAlive(info.pid) || (await terminate(info))
    if (!stopped) this.stopping = false
    return stopped
  }

  /** The OS is ending the session: asks the daemon to stop, without blocking on it. */
  requestShutdown(): void {
    const info = readInfo()
    if (info) void terminate(info).catch(() => undefined)
  }

  /** The running daemon, if healthy; never spawns one (tray status, the app quitting). */
  async running(): Promise<DaemonInfo | null> {
    if (this.stopping) return null
    const info = readInfo()
    return info && (await isHealthy(info)) ? info : null
  }

  async connection(): Promise<DaemonConnection> {
    return toConnection(await this.ensure())
  }

  /** A client of the daemon, spawning it when none is running. */
  async client(): Promise<ApiClient> {
    return createApiClient(await this.connection())
  }

  /** A client of the running daemon, or null (never spawns one). */
  async runningClient(): Promise<ApiClient | null> {
    const info = await this.running()
    return info ? createApiClient(toConnection(info)) : null
  }

  private async startOrAdopt(): Promise<DaemonInfo> {
    const current = readInfo()
    if (current && (await isHealthy(current))) {
      if (!isOutdated(current)) return current
      console.log(`[main] daemon ${current.version} is outdated (app ${app.getVersion()}); restarting it`)
      if (!(await terminate(current))) throw new Error(`Daemon ${current.pid} did not stop`)
    }

    if (this.external) {
      const info = await waitForHealthy(EXTERNAL_WAIT_MS)
      if (!info) throw new Error('External daemon did not come up (MILIBOT_DAEMON_EXTERNAL=1)')
      return info
    }

    spawnDaemon()
    const info = await waitForHealthy(START_TIMEOUT_MS)
    if (!info) throw new Error(`Daemon did not start; see ${appPaths().daemonLog}`)
    return info
  }
}

function readInfo(): DaemonInfo | null {
  try {
    return DaemonInfo.parse(JSON.parse(readFileSync(appPaths().daemonInfo, 'utf8')))
  } catch {
    return null
  }
}

async function isHealthy(info: DaemonInfo): Promise<boolean> {
  return pidAlive(info.pid) && (await isDaemonHealthy(info, HEALTH_TIMEOUT_MS))
}

/** The daemon outlives the app, so after an update the running one can be the previous version. */
function isOutdated(info: DaemonInfo): boolean {
  return usesPackagedDaemon() && info.version !== app.getVersion()
}

async function waitForHealthy(timeoutMs: number): Promise<DaemonInfo | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const info = readInfo()
    if (info && (await isHealthy(info))) return info
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
  return null
}

function spawnDaemon(): void {
  const { command, args, env, cwd } = resolveDaemonCommand()
  if (cwd && !existsSync(cwd)) throw new Error(`Daemon directory not found: ${cwd}`)
  const paths = appPaths()
  mkdirSync(paths.logsDir, { recursive: true })
  const log = openSync(paths.daemonLog, 'a')
  try {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      // Windows: a detached console process would otherwise open its own console window.
      windowsHide: true,
      stdio: ['ignore', log, log],
      env: daemonEnvironment(process.env, env),
    })
    child.unref()
  } finally {
    closeSync(log)
  }
}

/** Graceful stop: `POST /shutdown`, else SIGTERM on macOS/Linux (see `shutdownDaemon`). */
async function terminate(info: DaemonInfo, timeoutMs = STOP_TIMEOUT_MS): Promise<boolean> {
  const result = await shutdownDaemon(
    { pid: info.pid, baseUrl: daemonBaseUrl(info), token: info.token },
    {
      fetch,
      isAlive: pidAlive,
      kill: (pid, signal) => process.kill(pid, signal),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: Date.now,
      platform: process.platform,
    },
    timeoutMs,
  )
  if (result.method === 'signal') console.log('[main] daemon has no shutdown route; stopped it with SIGTERM')
  return result.stopped
}
