import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  type ApiClient,
  ApiError,
  AppEventEnvelope,
  type GoldenStatus,
  type WorkspaceSummary,
} from '@milibot/shared'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

import type { MemorySecretStore } from '../../src/secrets/secret-store'
import type { Supervisor } from '../../src/supervisor/server'
import { startSupervisor } from '../support/supervisor-harness'
import { removeDir, tempDir } from '../support/temp'

/**
 * Prints what vm/build.sh prints and writes a versioned golden with the revision from `golden-revision`
 * next to it (default 1); fails the first time when `fail-once` exists.
 */
const FAKE_BUILD = `#!/bin/bash
echo "run $*" >> "$MILIBOT_HOME/build-args"
log() { echo "[build 10:00:00] $*" >&2; }
log "checking base image"
log "downloading debian-13-genericcloud-arm64.qcow2"
printf '\\r 50  412M   50  206M    0     0  20.0M      0  0:00:20  0:00:10  0:00:10 20.0M' >&2
sleep 1.3
printf '\\r100  412M  100  412M    0     0  20.0M      0  0:00:20  0:00:20 --:--:-- 20.0M\\n' >&2
log "bundling guest agent"
log "booting build VM (8 vCPU, 8G)"
if [ -f "$MILIBOT_HOME/fail-once" ]; then
  rm -f "$MILIBOT_HOME/fail-once"
  log "ERROR: provisioning failed (rc=1)"
  exit 1
fi
log "guest: base packages"
sleep 1.3
log "flattening into golden"
rev="$(cat "$(dirname "$0")/golden-revision" 2>/dev/null || echo 1)"
images="$MILIBOT_HOME/images"
mkdir -p "$images"
: > "$images/debian13-golden-$rev-arm64.qcow2"
echo "{\\"revision\\": $rev}" > "$images/debian13-golden-$rev-arm64.json"
ln -sfn "debian13-golden-$rev-arm64.qcow2" "$MILIBOT_GOLDEN_IMAGE"
log "golden image ready in 2s"
`

let dataRoot: string
let supervisor: Supervisor
let secrets: MemorySecretStore
let client: ApiClient
let baseUrl: string
const savedEnv = { ...process.env }
const goldenStatuses: GoldenStatus[] = []
let appSocket: WebSocket

async function until<T>(
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() > deadline) throw new Error(`timed out; last value ${JSON.stringify(value)}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

beforeAll(async () => {
  dataRoot = tempDir('setup')
  const script = join(dataRoot, 'fake-build.sh')
  writeFileSync(script, FAKE_BUILD)
  chmodSync(script, 0o755)
  const fakeLlm = join(dataRoot, 'fake-llm.json')
  writeFileSync(fakeLlm, JSON.stringify([{ text: 'Hi! I am your first bot.' }]))
  process.env.MILIBOT_VM_BUILD = script
  process.env.MILIBOT_GOLDEN_IMAGE = join(dataRoot, 'images', 'debian13-golden.qcow2')
  process.env.MILIBOT_FAKE_LLM = fakeLlm
  delete process.env.MILIBOT_BUILD_DIR
  ;({ supervisor, secrets, client, baseUrl } = await startSupervisor({ dataRoot }))
  appSocket = new WebSocket(`${baseUrl.replace('http', 'ws')}/events?token=${supervisor.token}`)
  appSocket.on('message', (data) => {
    const { event } = AppEventEnvelope.parse(JSON.parse(String(data)))
    if (event.type === 'golden.status') goldenStatuses.push(event.payload.status)
  })
  await new Promise<void>((resolve, reject) => {
    appSocket.once('open', () => resolve())
    appSocket.once('error', reject)
  })
})

afterAll(async () => {
  appSocket?.close()
  await supervisor?.close()
  process.env = savedEnv
  if (dataRoot) removeDir(dataRoot)
})

describe('workspace setup', () => {
  let workspace: WorkspaceSummary

  it('creates workspaces waiting for setup (API-created ones stay ready)', async () => {
    const plain = await client.call('createWorkspace', { body: { name: 'Plain', color: 'blue' } })
    expect(plain.setup).toBe('done')
    workspace = await client.call('createWorkspace', {
      body: { name: 'Fresh', color: 'teal', setup: true, closeBehavior: 'suspend_vm' },
    })
    expect(workspace).toMatchObject({ setup: 'providers', closeBehavior: 'suspend_vm' })
    expect((await client.call('listWorkspaces', {})).find((w) => w.id === workspace.id)?.setup).toBe(
      'providers',
    )
  })

  it('keeps the first bot quiet while providers are configured', async () => {
    const params = { workspaceId: workspace.id }
    await client.call('createProvider', {
      params,
      body: { type: 'openai_compatible', name: 'OpenRouter', preset: 'openrouter', apiKey: 'sk-or-x' },
    })
    const chief = (await client.call('listBots', { params }))[0]
    const dm = (await client.call('listConversations', { params })).find((c) =>
      c.memberBotIds.includes(chief?.id ?? ''),
    )
    await new Promise((r) => setTimeout(r, 300))
    const page = await client.call('listMessages', {
      params: { ...params, conversationId: dm?.id ?? '' },
      query: { limit: 10 },
    })
    expect(page.messages).toHaveLength(0)
  })

  it('refuses to skip steps', async () => {
    await expect(
      client.call('updateWorkspaceSetup', { params: { workspaceId: workspace.id }, body: { step: 'login' } }),
    ).rejects.toBeInstanceOf(ApiError)
  })

  it('builds the missing golden image, reporting progress, and retries after a failure', async () => {
    expect((await client.call('getGoldenImage', {})).state).toBe('missing')
    writeFileSync(join(dataRoot, 'fail-once'), '')
    const updated = await client.call('setupWorkspaceVm', {
      params: { workspaceId: workspace.id },
      body: { cpus: 2, memGb: 4, dataGb: 40 },
    })
    expect(updated.setup).toBe('vm')
    const failed = await until(
      () => client.call('getGoldenImage', {}),
      (s) => s.state === 'failed',
    )
    expect(failed.error).toBe('provisioning failed (rc=1)')

    const retryFrom = goldenStatuses.length
    expect((await client.call('buildGoldenImage', {})).state).toBe('building')
    await until(
      () => client.call('getGoldenImage', {}),
      (s) => s.state === 'ready',
    )
    const building = goldenStatuses.slice(retryFrom).filter((s) => s.state === 'building')
    expect(building.some((s) => s.stage === 'download' && s.downloadBytes === 412 * 1024 ** 2)).toBe(true)
    expect(building.some((s) => s.stage === 'install')).toBe(true)
    const percents = building.map((s) => s.percent)
    expect(percents).toEqual([...percents].sort((a, b) => a - b))
    expect(goldenStatuses.at(-1)?.state).toBe('ready')
    expect(existsSync(join(dataRoot, 'images', 'golden-build.json'))).toBe(false)

    const db = new Database(join(workspace.dir, 'workspace.db'), { readonly: true })
    const setting = (key: string) =>
      (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)
        ?.value
    expect([setting('vm.vcpus'), setting('vm.memory_gb'), setting('vm.data_disk_gb')]).toEqual([
      '2',
      '4',
      '40',
    ])
    expect(setting('setup.vm_pending')).toBe('false')
    db.close()
  })

  it('introduces the first bot once the setup is done', async () => {
    const params = { workspaceId: workspace.id }
    const done = await client.call('updateWorkspaceSetup', {
      params: { workspaceId: workspace.id },
      body: { step: 'done' },
    })
    expect(done.setup).toBe('done')
    const chief = (await client.call('listBots', { params }))[0]
    const dm = (await client.call('listConversations', { params })).find((c) =>
      c.memberBotIds.includes(chief?.id ?? ''),
    )
    const messages = await until(
      async () =>
        (
          await client.call('listMessages', {
            params: { ...params, conversationId: dm?.id ?? '' },
            query: { limit: 10 },
          })
        ).messages,
      (m) => m.some((x) => x.authorBotId === chief?.id && x.content.includes('first bot')),
    )
    expect(messages.length).toBeGreaterThan(0)
  })

  it('copies providers, models and the VM size from another workspace', async () => {
    const [source] = await client.call('listProviders', { params: { workspaceId: workspace.id } })
    // Runtimes use their own in-memory store in tests; the supervisor copies what its store holds.
    await secrets.set(workspace.id, `provider.${source?.id}.secret`, 'sk-or-x')
    const copy = await client.call('createWorkspace', {
      body: {
        name: 'Copy',
        color: 'pink',
        setup: true,
        copyFrom: { workspaceId: workspace.id, providers: true, keys: true, vmSize: true },
      },
    })
    const providers = await client.call('listProviders', { params: { workspaceId: copy.id } })
    expect(providers.map((p) => [p.name, p.preset, p.isDefault])).toEqual([
      ['OpenRouter', 'openrouter', true],
    ])
    const db = new Database(join(copy.dir, 'workspace.db'), { readonly: true })
    const value = (key: string) =>
      (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)
        ?.value
    expect([value('vm.vcpus'), value('vm.memory_gb'), value('vm.data_disk_gb')]).toEqual(['2', '4', '40'])
    expect(value('setup.pending')).toBe('true')
    db.close()
    expect(await secrets.get(copy.id, `provider.${source?.id}.secret`)).toBe('sk-or-x')
  })

  it('rebuilds an outdated golden image before creating the VM of a new workspace', async () => {
    writeFileSync(join(dataRoot, 'golden-revision'), '2\n')
    expect(await client.call('getGoldenImage', {})).toMatchObject({
      state: 'ready',
      revision: 1,
      latestRevision: 2,
      outdated: true,
    })
    const fresh = await client.call('createWorkspace', {
      body: { name: 'Another', color: 'blue', setup: true, closeBehavior: 'suspend_vm' },
    })
    const waitsForGolden = () => {
      const db = new Database(join(fresh.dir, 'workspace.db'), { readonly: true })
      try {
        return (
          db.prepare('SELECT value FROM settings WHERE key = ?').get('setup.vm_wait_golden') as
            { value: string } | undefined
        )?.value
      } finally {
        db.close()
      }
    }
    const runsBefore = readFileSync(join(dataRoot, 'build-args'), 'utf8').trim().split('\n').length
    await client.call('setupWorkspaceVm', {
      params: { workspaceId: fresh.id },
      body: { cpus: 2, memGb: 4, dataGb: 40 },
    })
    expect((await client.call('getGoldenImage', {})).state).toBe('building')
    expect(waitsForGolden()).toBe('true')

    const ready = await until(
      () => client.call('getGoldenImage', {}),
      (s) => s.state === 'ready',
    )
    expect(ready).toMatchObject({ revision: 2, outdated: false, error: null })
    const runs = readFileSync(join(dataRoot, 'build-args'), 'utf8').trim().split('\n')
    expect(runs.slice(runsBefore)).toEqual(['run --rebuild'])
    // The build's `onReady` asks the runtime to create the VM, which ends the wait.
    await until(waitsForGolden, (value) => value === 'false')
  })
})
