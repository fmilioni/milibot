import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { type ApiClient, createApiClient, type WorkspaceEvent, WorkspaceEventEnvelope } from '@milibot/shared'
import WebSocket from 'ws'

import { MemorySecretStore } from '../../src/secrets/secret-store'
import { createSupervisor, type Supervisor, type SupervisorOptions } from '../../src/supervisor/server'

const require = createRequire(import.meta.url)

/** Runtimes forked by a test supervisor run the TypeScript sources through tsx. */
const TEST_RUNTIME_LAUNCHER = {
  entry: fileURLToPath(new URL('../../src/runtime-main.ts', import.meta.url)),
  execArgv: ['--import', pathToFileURL(require.resolve('tsx')).href],
}

export interface SupervisorHarness {
  supervisor: Supervisor
  client: ApiClient
  baseUrl: string
  secrets: MemorySecretStore
  close(): Promise<void>
}

export async function startSupervisor(
  options: { dataRoot: string; secrets?: MemorySecretStore; runtimeEnv?: Record<string, string> } & Omit<
    Partial<SupervisorOptions>,
    'dataRoot' | 'secretStore' | 'runtime'
  >,
): Promise<SupervisorHarness> {
  const { secrets = new MemorySecretStore(), runtimeEnv, ...rest } = options
  const supervisor = createSupervisor({
    secretStore: secrets,
    runtime: { ...TEST_RUNTIME_LAUNCHER, ...(runtimeEnv ? { env: runtimeEnv } : {}) },
    ...rest,
    config: { logLevel: 'error', ...rest.config },
  })
  const port = await supervisor.listen(0)
  const baseUrl = `http://127.0.0.1:${port}`
  return {
    supervisor,
    client: createApiClient({ baseUrl, token: supervisor.token, validateResponses: true }),
    baseUrl,
    secrets,
    close: () => supervisor.close(),
  }
}

/** Collects a workspace's WS events. */
export function subscribeWorkspace(harness: SupervisorHarness, workspaceId: string) {
  const events: WorkspaceEvent[] = []
  const socket = new WebSocket(
    `${harness.baseUrl.replace('http', 'ws')}/w/${workspaceId}/events?token=${harness.supervisor.token}`,
  )
  socket.on('message', (data) => events.push(WorkspaceEventEnvelope.parse(JSON.parse(String(data))).event))
  const opened = new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
  const waitFor = async <T extends WorkspaceEvent['type']>(type: T, timeoutMs = 5_000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = events.find((e) => e.type === type)
      if (found) return found as Extract<WorkspaceEvent, { type: T }>
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error(`timed out waiting for ${type}; got ${events.map((e) => e.type).join(', ')}`)
  }
  return { socket, events, opened, waitFor }
}
