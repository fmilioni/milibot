import { readRuntimeConfig } from './config/env'
import { toApiError } from './errors'
import { SupervisorCallClient } from './ipc/calls'
import type { RuntimeToSupervisor, SupervisorToRuntime, VmShutdownMode } from './ipc/protocol'
import { createLogger, logFn } from './logging'
import { createRuntimeFromConfig } from './runtime/process'
import { installProcessGuard } from './util/process-guard'

function send(message: RuntimeToSupervisor): void {
  process.send?.(message)
}

async function main(): Promise<void> {
  if (!process.send) throw new Error('runtime must be forked by the supervisor with an IPC channel')
  const config = readRuntimeConfig()
  const logger = createLogger(config.logLevel).child({ workspaceId: config.workspaceId })
  const log = logFn(logger)
  installProcessGuard(log)
  const calls = new SupervisorCallClient((message, callback) => {
    if (!process.send || !process.connected) {
      callback(new Error('IPC channel closed'))
      return
    }
    process.send(message, undefined, {}, callback)
  })

  const proc = createRuntimeFromConfig(config, {
    emit: (event) => send({ type: 'event', event }),
    log,
    calls,
  })
  await proc.start()

  let shuttingDown = false
  const shutdown = async (vmMode: VmShutdownMode = 'keep') => {
    if (shuttingDown) return
    shuttingDown = true
    await proc.stop(vmMode)
    process.exit(0)
  }

  process.on('message', (raw: SupervisorToRuntime) => {
    if (calls.handle(raw)) return
    switch (raw.type) {
      case 'shutdown':
        void shutdown(raw.vm ?? 'keep')
        return
      case 'opened':
        proc.opened()
        return
      case 'close_behavior':
        proc.closeBehaviorChanged(raw.closeBehavior)
        return
      case 'request':
        proc.runtime
          .handle(raw.endpoint, raw.params, raw.query, raw.body)
          .then((result) => send({ type: 'response', id: raw.id, ok: true, result }))
          .catch((err: unknown) => {
            const { error, unexpected } = toApiError(err)
            if (unexpected) logger.error({ err, endpoint: raw.endpoint }, 'request failed')
            send({ type: 'response', id: raw.id, ok: false, error })
          })
    }
  })
  process.on('disconnect', () => {
    calls.close()
    void shutdown()
  })
  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())

  send({ type: 'ready' })
}

main().catch((err: unknown) => {
  createLogger('fatal').fatal({ err }, 'runtime failed to start')
  process.exit(1)
})
