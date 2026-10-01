import { mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { DaemonInfo, isDaemonHealthy } from '@milibot/shared'
import { pidAlive } from '@milibot/vm-host'

import { readDaemonConfig } from './config/env'
import { DAEMON_VERSION, dataPaths } from './config/paths'
import { createLogger, logFn } from './logging'
import { resolveSecretStore } from './secrets/factory'
import { createSupervisor } from './supervisor/server'
import { writeFileAtomic } from './util/fs'

function readDaemonInfo(path: string): DaemonInfo | null {
  try {
    return DaemonInfo.parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

/** The runtime entry sits next to this file both in source (tsx) and in the esbuild bundle. */
function runtimeEntry(): string {
  const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
  return fileURLToPath(new URL(`./runtime-main.${ext}`, import.meta.url))
}

async function main(): Promise<void> {
  const config = readDaemonConfig()
  const logger = createLogger(config.logLevel)
  const paths = dataPaths(config.dataRoot)
  mkdirSync(paths.root, { recursive: true })

  const previous = readDaemonInfo(paths.daemonInfo)
  if (
    previous &&
    previous.pid !== process.pid &&
    pidAlive(previous.pid) &&
    (await isDaemonHealthy(previous, 1500))
  ) {
    logger.info({ pid: previous.pid, port: previous.port }, 'milibotd already running; exiting')
    return
  }

  const secrets = await resolveSecretStore({
    dataRoot: paths.root,
    explicit: config.secretStore,
    log: logFn(logger),
  })

  // daemon.json is kept on shutdown: reusing port and token of a dead daemon lets open windows
  // reconnect transparently after a restart. Staleness is detected through the pid.
  const supervisor = createSupervisor({
    dataRoot: paths.root,
    token: previous?.token,
    secretStore: secrets.store,
    secretStoreInfo: secrets.info,
    requestShutdown: (reason) => void shutdown(reason),
    // Runtimes use the same store without probing again.
    runtime: {
      entry: runtimeEntry(),
      execArgv: process.execArgv,
      env: { MILIBOT_SECRET_STORE: secrets.info.kind },
    },
    config,
  })

  const requestedPort = config.port ?? previous?.port ?? 0
  let port: number
  try {
    port = await supervisor.listen(requestedPort)
  } catch (err) {
    if (requestedPort === 0) throw err
    port = await supervisor.listen(0)
  }

  const info: DaemonInfo = {
    pid: process.pid,
    host: '127.0.0.1',
    port,
    token: supervisor.token,
    version: DAEMON_VERSION,
    startedAt: Date.now(),
  }
  writeFileAtomic(paths.daemonInfo, JSON.stringify(info, null, 2), { mode: 0o600 })
  supervisor.app.log.info({ port, dataRoot: paths.root }, 'milibotd ready')
  void supervisor.autoStartRuntimes()

  let closing = false
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    supervisor.app.log.info({ signal }, 'milibotd shutting down')
    await supervisor.close().catch(() => undefined)
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err: unknown) => {
  createLogger('fatal').fatal({ err }, 'milibotd failed to start')
  process.exit(1)
})
