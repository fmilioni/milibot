import type {
  KnowledgeDoc,
  OfficeStatus,
  UploadProgress,
  WorkspaceEvent,
  WorkspacePreferences,
} from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import type { WorkspaceRuntime } from '../../../src/runtime/runtime'
import type { QemuVmController } from '../../../src/runtime/vm/controller'
import { type FakeGuest, fakeGuest } from '../../support/fake-guest'
import { bootRuntime, type RuntimeHarness, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'
import { until as waitUntil } from '../../support/wait'

let h: RuntimeHarness
let runtime: WorkspaceRuntime
let events: WorkspaceEvent[]
let guest: FakeGuest
let vm: QemuVmController
const dir = useTempDir('office')
afterEach(stopRuntimes)

const oldDoc = () =>
  new Uint8Array(
    Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(504),
      Buffer.from('WordDocument\0', 'utf16le'),
    ]),
  )

async function boot(options: { autostart?: boolean } = {}) {
  const officeGuest = fakeGuest()
  officeGuest.state.office.polls = 1
  officeGuest.state.extract = (req) =>
    req.query.kind === 'doc' && officeGuest.state.office.installed
      ? {
          kind: 'doc',
          pages: [{ n: 1, text: '# Minutes\n\nMarch budget approved by the board.', ocr: false }],
          meta: { pageCount: 1, pseudoPages: true, ocrSkipped: [], truncated: false, durationMs: 2 },
        }
      : { error: { code: 'office_missing', message: 'no soffice' }, status: 503 }
  h = await bootRuntime({
    dir: dir(),
    guest: officeGuest,
    script: () => ({ text: 'Minutes of the board meeting.' }),
    vm: { autostart: options.autostart ?? true },
  })
  ;({ runtime, events, guest } = h)
  vm = h.vm!
}

const until = (check: () => boolean) => waitUntil(check, 8000)
const call: RuntimeHarness['call'] = (...args) => h.call(...args)

const status = () => call<OfficeStatus>('getOfficeStatus')
const setLegacyOffice = (legacyOffice: boolean) =>
  call<WorkspacePreferences>('updateWorkspacePreferences', {}, { legacyOffice })
const officeEvents = () => events.flatMap((e) => (e.type === 'office.status' ? [e.payload.status] : []))
const docState = (id: string) => runtime.services.knowledge.docs.row(id)

async function upload(name: string, bytes: Uint8Array): Promise<KnowledgeDoc> {
  const up = await call<UploadProgress>('createKnowledgeUpload', {}, { name, size: bytes.length })
  await call(
    'uploadKnowledgeChunk',
    { uploadId: up.id },
    { offset: 0, data: Buffer.from(bytes).toString('base64') },
  )
  return call<KnowledgeDoc>('completeKnowledgeUpload', { uploadId: up.id })
}

describe('"Old Office files" (fake VM)', () => {
  it('refuses old Office files while off, installs with progress when turned on, and removes when off', async () => {
    await boot()
    expect(await status()).toMatchObject({ enabled: false, state: 'off', installMb: 360 })
    await expect(upload('minutes.doc', oldDoc())).rejects.toMatchObject({
      code: 'validation_failed',
      details: { reason: 'unsupported_format', hint: 'legacy_office_disabled' },
    })
    expect(guest.state.office.requests).toEqual([])

    await setLegacyOffice(true)
    await until(() => officeEvents().some((s) => s.state === 'installing'))
    await until(() => officeEvents().at(-1)?.state === 'installed')
    expect(officeEvents().find((s) => s.state === 'installing')).toMatchObject({ phase: 'downloading' })
    expect(guest.state.office.requests).toEqual(['install'])

    const doc = await upload('minutes.doc', oldDoc())
    expect(doc.kind).toBe('docx')
    await until(() => docState(doc.id).status === 'ready')
    expect(guest.state.extracts.at(-1)!.query).toMatchObject({ name: 'minutes.doc', kind: 'doc' })

    await setLegacyOffice(false)
    await until(() => officeEvents().at(-1)?.state === 'off')
    expect(officeEvents().some((s) => s.state === 'removing')).toBe(true)
    expect(guest.state.office).toMatchObject({ installed: false, requests: ['install', 'remove'] })
  })

  it('waits for the VM, installs when it starts, reinstalls after a reset, and holds old files until ready', async () => {
    await boot({ autostart: false })
    await setLegacyOffice(true)
    expect(await status()).toMatchObject({ enabled: true, state: 'waiting_vm' })
    const doc = await upload('sheet.doc', oldDoc())
    expect(docState(doc.id).status).toBe('queued')

    guest.state.office.polls = 3
    await call('startVm')
    await until(() => vm.info().state === 'running')
    await until(() => (guest.state.office.running as string | null) === 'install')
    // Not sent to the VM before LibreOffice is there.
    expect(guest.state.extracts).toEqual([])
    await until(() => docState(doc.id).status === 'ready')
    expect(guest.state.extracts).toHaveLength(1)
    expect((await status()).state).toBe('installed')

    // A system reset replaces the disk LibreOffice was on: the next boot installs it again.
    guest.state.office.polls = 1
    await call('stopVm')
    await until(() => vm.info().state === 'stopped')
    expect((await status()).state).toBe('installed')
    guest.state.office.installed = false
    await call('startVm')
    await until(() => guest.state.office.requests.length === 2)
    await until(() => officeEvents().at(-1)?.state === 'installed')
    expect(guest.state.office.requests).toEqual(['install', 'install'])
  })

  it('reports a failed install, and a retry reads the documents that failed for lack of it', async () => {
    await boot()
    guest.state.office.fail = 'apt-get update failed (no network?)'
    await setLegacyOffice(true)
    await until(() => officeEvents().at(-1)?.state === 'error')
    expect(await status()).toMatchObject({ state: 'error', error: expect.stringContaining('no network') })

    const doc = await upload('minutes.doc', oldDoc())
    await until(() => docState(doc.id).status === 'failed')
    expect(docState(doc.id).error_code).toBe('office_missing')

    guest.state.office.fail = null
    expect((await call<OfficeStatus>('retryOffice')).state).toBe('installing')
    await until(() => officeEvents().at(-1)?.state === 'installed')
    await until(() => docState(doc.id).status === 'ready')
  })
})
