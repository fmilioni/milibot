import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { gunzipSync } from 'node:zlib'

import type { BackupJob, BackupRestore, WorkspaceEvent } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import {
  extractBackupDb,
  inspectBackup,
  knowledgeEntryTarget,
  prepareImportedDb,
  skillEntryTarget,
} from '../../../src/backup/archive'
import type { Db } from '../../../src/db/sqlite'
import { BackupService, parseQemuImgProgress, qemuImgConvertArgs } from '../../../src/runtime/backup/service'
import { QemuVmController } from '../../../src/runtime/vm/controller'
import { WorkspaceStore } from '../../../src/runtime/workspace-store'
import { ZipReader } from '../../../src/util/zip'
import { openWorkspaceDb } from '../../../src/workspace-db/open'
import { seedWorkspace } from '../../../src/workspace-db/seed'
import { fakeGuest } from '../../support/fake-guest'
import { FakeVmCli } from '../../support/fake-vm-cli'
import { readTar } from '../../support/tar'
import { useTempDir } from '../../support/temp'
import { until } from '../../support/wait'

const dir = useTempDir('backup')

function setup(options: { db?: Db; qemuImg?: string | null; vmPending?: boolean } = {}) {
  const wsDir = join(dir(), 'ws')
  mkdirSync(wsDir, { recursive: true })
  const db = options.db ?? openWorkspaceDb(':memory:')
  if (!options.db) seedWorkspace(new WorkspaceStore(db), 'en')
  const store = new WorkspaceStore(db)
  const guest = fakeGuest()
  const events: WorkspaceEvent[] = []
  const vm = new QemuVmController({
    workspaceDir: wsDir,
    workspaceName: 'test',
    portBase: 47500,
    cli: new FakeVmCli(),
    golden: () => '/images/debian13-golden.qcow2',
    settings: () => ({ cpus: 2, memGb: 4, dataGb: 20, systemGb: 30 }),
    bots: () => store.bots.list(),
    emit: () => undefined,
    guestFactory: guest.client,
    pollIntervalMs: 5,
  })
  const service = new BackupService({
    db,
    workspaceDir: wsDir,
    workspaceName: () => 'Personal',
    version: '1.2.3',
    vm,
    getSetting: (key, fallback) => store.settings.get(key, fallback),
    setSetting: (key, value) => store.settings.set(key, value),
    vmPending: () => options.vmPending ?? false,
    emit: (event) => events.push(event),
    now: Date.now,
    qemuImg: () => (options.qemuImg === undefined ? null : options.qemuImg),
    log: () => undefined,
  })
  service.start()
  return { wsDir, db, store, guest, vm, service, events }
}

async function finished(service: BackupService): Promise<BackupJob> {
  await until(() => service.current()?.status !== 'running')
  return service.current() as BackupJob
}

describe('workspace backup', () => {
  it('writes a zip with the database and /workspace as tar.gz, without the excluded folders', async () => {
    const { guest, service, events, vm } = setup()
    await vm.start()
    guest.state.workspace.set('proj/README.md', '# project')
    guest.state.workspace.set('proj/src/index.ts', 'export {}')
    guest.state.workspace.set('proj/node_modules/lib/index.js', 'x'.repeat(5000))
    const path = join(dir(), 'backup.zip')
    service.begin({ kind: 'archive', path, includeWorkspace: true })
    const job = await finished(service)
    expect(job).toMatchObject({ status: 'done', progress: 1, error: null })
    expect(job.bytesTotal).toBe('# project'.length + 'export {}'.length + 2 * 768 + 10_240)
    expect(guest.state.archiveExcludes).toEqual(['node_modules', '.venv', 'target', 'dist', '.cache'])
    expect(events.some((e) => e.type === 'backup.job' && e.payload.job.phase === 'workspace')).toBe(true)

    const zip = await ZipReader.open(path)
    expect(zip.entries.map((e) => e.name)).toEqual([
      'manifest.json',
      'workspace.db',
      'bots.json',
      'memories.json',
      'procedures.json',
      'workspace.tar.gz',
    ])
    const manifest = JSON.parse((await zip.read('manifest.json')).toString()) as Record<string, unknown>
    expect(manifest).toMatchObject({
      format: 'milibot-workspace-backup',
      formatVersion: 1,
      workspace: 'Personal',
    })
    const files = readTar(gunzipSync(await zip.read('workspace.tar.gz')))
    expect([...files.keys()].sort()).toEqual(['proj/README.md', 'proj/src/index.ts'])
    expect(await inspectBackup(path)).toMatchObject({
      workspaceName: 'Personal',
      bots: 1,
      milibotVersion: '1.2.3',
    })
    expect(readdirSync(dir()).filter((f) => f.endsWith('.partial'))).toEqual([])
    await vm.close()
  })

  it('leaves no file behind when the /workspace stream breaks, and refuses a second job while one runs', async () => {
    const { guest, service, vm } = setup()
    await vm.start()
    guest.state.workspace.set('a.txt', 'a'.repeat(4000))
    guest.state.breakArchiveAfter = 600
    const path = join(dir(), 'broken.zip')
    service.begin({ kind: 'archive', path, includeWorkspace: true, excludes: [] })
    expect(() =>
      service.begin({ kind: 'archive', path: join(dir(), 'other.zip'), includeWorkspace: false }),
    ).toThrow(/already running/)
    const job = await finished(service)
    expect(job.status).toBe('error')
    expect(job.error).toBeTruthy()
    expect(existsSync(path)).toBe(false)
    expect(existsSync(`${path}.partial`)).toBe(false)
    await vm.close()
  })

  it('validates the destination', () => {
    const { service } = setup()
    expect(() => service.begin({ kind: 'archive', path: 'relative.zip', includeWorkspace: false })).toThrow(
      /absolute/,
    )
    expect(() =>
      service.begin({ kind: 'archive', path: join(dir(), 'nope', 'x.zip'), includeWorkspace: false }),
    ).toThrow(/folder does not exist/)
  })

  it('copies the data disk with qemu-img, stopping and restarting a running VM only when allowed', async () => {
    const fakeQemuImg = join(dir(), 'qemu-img')
    writeFileSync(
      fakeQemuImg,
      `#!/bin/bash\nprintf '    (0.00/100%%)\\r    (50.00/100%%)\\r    (100.00/100%%)\\r'\ncp "\${@: -2:1}" "\${@: -1}"\n`,
    )
    chmodSync(fakeQemuImg, 0o755)
    const { service, vm, wsDir } = setup({ qemuImg: fakeQemuImg })
    await vm.start()
    writeFileSync(join(wsDir, 'vm', 'data.qcow2'), 'disk-bytes')
    const path = join(dir(), 'data-copy.qcow2')
    expect(() => service.begin({ kind: 'disk', path, stopVm: false })).toThrow(/Stop the VM/)
    service.begin({ kind: 'disk', path, stopVm: true })
    const job = await finished(service)
    expect(job).toMatchObject({ status: 'done', outputBytes: 'disk-bytes'.length, bytesTotal: 10 })
    await until(() => vm.info().state === 'running')
    await vm.close()
  })

  it('parses qemu-img progress and builds the convert command', () => {
    expect(parseQemuImgProgress('    (12.50/100%)\r    (37.00/100%)\r')).toBeCloseTo(0.37)
    expect(parseQemuImgProgress('nothing')).toBeNull()
    expect(qemuImgConvertArgs('/a/data.qcow2', '/b/copy.qcow2')).toEqual([
      'convert',
      '-p',
      '-O',
      'qcow2',
      '-c',
      '/a/data.qcow2',
      '/b/copy.qcow2',
    ])
  })
})

describe('importing a backup', () => {
  async function makeBackup(): Promise<string> {
    const source = setup()
    await source.vm.start()
    source.guest.state.workspace.set('repos/app/main.go', 'package main')
    source.store.settings.set('claude_code.session.bot_x', 'old-session')
    const path = join(dir(), 'source.zip')
    source.service.begin({ kind: 'archive', path, includeWorkspace: true })
    expect((await finished(source.service)).status).toBe('done')
    await source.vm.close()
    return path
  }

  it('prepares the database for the setup and restores /workspace once the new VM runs', async () => {
    const path = await makeBackup()
    const dbPath = join(dir(), 'imported.db')
    const extracted = await extractBackupDb(path, dbPath)
    expect(extracted.hasWorkspace).toBe(true)
    const db = openWorkspaceDb(dbPath)
    prepareImportedDb(db, { backupPath: path, hasWorkspace: true, workspaceBytes: extracted.bytes, now: 5 })
    const store = new WorkspaceStore(db)
    expect(store.settings.get('setup.pending', false)).toBe(true)
    expect(store.settings.get('setup.vm_pending', false)).toBe(true)
    expect(store.settings.get('claude_code.session.bot_x', null)).toBeNull()
    expect(store.bots.list().map((b) => b.name)).toEqual(['Maestro'])

    const target = setup({ db })
    expect(target.service.restore()).toMatchObject({ status: 'pending' })
    await target.vm.start()
    await until(() => target.service.restore()?.status === 'done')
    expect(target.guest.state.workspace.get('repos/app/main.go')).toBe('package main')
    expect(target.events.some((e) => e.type === 'backup.restore')).toBe(true)
    await target.vm.close()
  })

  it('reports a moved backup file and restores after choosing it again', async () => {
    const path = await makeBackup()
    const dbPath = join(dir(), 'imported.db')
    const extracted = await extractBackupDb(path, dbPath)
    const db = openWorkspaceDb(dbPath)
    const moved = join(dir(), 'moved.zip')
    prepareImportedDb(db, {
      backupPath: join(dir(), 'gone.zip'),
      hasWorkspace: true,
      workspaceBytes: extracted.bytes,
      now: 5,
    })
    writeFileSync(moved, '')
    rmSync(moved)
    const target = setup({ db })
    await target.vm.start()
    await until(() => target.service.restore()?.status === 'error')
    expect(target.service.restore()).toMatchObject({
      errorReason: 'file_missing',
      error: expect.stringMatching(/no longer at/),
    })
    expect(() => target.service.retryRestore(moved)).toThrow(/not found/)
    const restore = target.service.retryRestore(path)
    expect(['pending', 'running']).toContain(restore.status)
    await until(() => target.service.restore()?.status === 'done')
    expect((target.service.restore() as BackupRestore).path).toBe(path)
    expect(target.guest.state.workspace.get('repos/app/main.go')).toBe('package main')
    await target.vm.close()
  })

  it('refuses files that are not Milibot backups', async () => {
    const path = join(dir(), 'random.zip')
    writeFileSync(path, 'not a zip')
    await expect(inspectBackup(path)).rejects.toThrow(/not a Milibot backup/)
    await expect(inspectBackup(join(dir(), 'missing.zip'))).rejects.toThrow(/not found/)
  })

  it('carries the skill folders and restores them without letting an entry escape the skills folder', async () => {
    const { wsDir, service } = setup()
    mkdirSync(join(wsDir, 'skills', 'monthly-close', 'scripts', 'deep'), { recursive: true })
    mkdirSync(join(wsDir, 'skills', '.staging-x'), { recursive: true })
    writeFileSync(join(wsDir, 'skills', 'monthly-close', 'SKILL.md'), '---\nname: monthly-close\n---\n')
    writeFileSync(join(wsDir, 'skills', 'monthly-close', 'scripts', 'deep', 'run.sh'), 'echo ok')
    writeFileSync(join(wsDir, 'skills', '.staging-x', 'half.md'), 'x')
    const path = join(dir(), 'skills.zip')
    service.begin({ kind: 'archive', path, includeWorkspace: false })
    expect((await finished(service)).status).toBe('done')
    const zip = await ZipReader.open(path)
    expect(
      zip.entries
        .map((e) => e.name)
        .filter((n) => n.startsWith('skills/'))
        .sort(),
    ).toEqual(['skills/monthly-close/SKILL.md', 'skills/monthly-close/scripts/deep/run.sh'])

    const target = join(dir(), 'restored')
    mkdirSync(target)
    await extractBackupDb(path, join(target, 'workspace.db'))
    expect(readFileSync(join(target, 'skills', 'monthly-close', 'scripts', 'deep', 'run.sh'), 'utf8')).toBe(
      'echo ok',
    )
    expect(existsSync(join(target, 'skills', '.staging-x'))).toBe(false)

    expect(skillEntryTarget('/ws', 'skills/a/b/c.md')).toBe('/ws/skills/a/b/c.md')
    for (const bad of [
      'skills/../x',
      'skills/a/../../x',
      'skills/a',
      'skills/.staging/x',
      'skills/a//b',
      'other/a/b',
    ])
      expect(skillEntryTarget('/ws', bad)).toBeNull()
  })

  it('keeps restored entries inside the workspace on Windows too', () => {
    expect(skillEntryTarget('C:\\ws', 'skills/a/b/c.md', win32)).toBe('C:\\ws\\skills\\a\\b\\c.md')
    expect(knowledgeEntryTarget('C:\\ws', 'knowledge/kdoc_1/original.pdf', win32)).toBe(
      'C:\\ws\\knowledge\\kdoc_1\\original.pdf',
    )
    expect(knowledgeEntryTarget('/ws', 'knowledge/kdoc_1/original.pdf')).toBe(
      '/ws/knowledge/kdoc_1/original.pdf',
    )
    for (const bad of [
      'knowledge/..\\..\\..\\Startup/x.bat',
      'knowledge/a/..\\x',
      'knowledge/C:/x',
      'knowledge/a:b/c',
      'knowledge/../x',
      'knowledge/a/b/c',
      'knowledge/a',
    ]) {
      expect(knowledgeEntryTarget('C:\\ws', bad, win32)).toBeNull()
      expect(knowledgeEntryTarget('/ws', bad)).toBeNull()
    }
    for (const bad of ['skills/..\\..\\x/y', 'skills/a/C:\\x', 'skills/a/b:c'])
      expect(skillEntryTarget('C:\\ws', bad, win32)).toBeNull()
  })
})
