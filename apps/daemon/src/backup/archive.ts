import { createReadStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import nodePath, { dirname, isAbsolute, join, type PlatformPath } from 'node:path'
import { type Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'

import { cliKeys } from '@milibot/agent/cli'
import { type BackupInfo, type BackupJobPhase, type BackupRestore, CLI_ENGINES } from '@milibot/shared'

import type { Db } from '../db/sqlite'
import { DaemonError } from '../errors'
import { requireTarget } from '../util/fs'
import { containedJoin } from '../util/safe-path'
import { ZipFormatError, ZipReader, ZipWriter } from '../util/zip'
import { SETUP_PENDING_KEY, SETUP_VM_PENDING_KEY } from '../workspace-db/setup-keys'

const BACKUP_FORMAT = 'milibot-workspace-backup'
export const BACKUP_RESTORE_KEY = 'backup.restore'

export const WORKSPACE_ENTRY = 'workspace.tar.gz'
/** Knowledge base files (`<wsDir>/knowledge/<docId>/…`) are stored under this prefix. */
const KNOWLEDGE_PREFIX = 'knowledge/'
/** Skill folders (`<wsDir>/skills/<slug>/…`, any depth) are stored under this prefix. */
const SKILLS_PREFIX = 'skills/'

/** Readable JSON exports next to the database (bots, memory notes, taught procedures). */
function readableExports(db: Db): Array<[string, unknown]> {
  return [
    [
      'bots.json',
      db
        .prepare(
          `SELECT id, name, slug, label, system_prompt AS systemPrompt, provider_id AS providerId, model,
           created_at AS createdAt FROM bots WHERE deleted_at IS NULL ORDER BY created_at`,
        )
        .all(),
    ],
    [
      'memories.json',
      db
        .prepare(
          `SELECT m.id, m.bot_id AS botId, b.name AS botName, m.content, m.pinned, m.created_at AS createdAt
         FROM memories m LEFT JOIN bots b ON b.id = m.bot_id ORDER BY m.seq`,
        )
        .all(),
    ],
    [
      'procedures.json',
      {
        procedures: db.prepare('SELECT * FROM procedures ORDER BY created_at').all(),
        steps: db.prepare('SELECT * FROM procedure_steps ORDER BY procedure_id, position').all(),
      },
    ],
  ]
}

export interface WriteBackupInput {
  db: Db
  path: string
  workspaceName: string
  version: string
  now: number
  /** Uncompressed tar of `/workspace` (stored gzipped as `workspace.tar.gz`), opened when its turn comes. */
  workspace?: { open: () => Promise<Readable>; excludes: string[]; onBytes?: (bytes: number) => void }
  /** `<wsDir>/knowledge`: the files of the knowledge base documents (originals and extracted text). */
  knowledgeDir: string
  /** `<wsDir>/skills`: the workspace's skill folders. */
  skillsDir: string
  onPhase?: (phase: BackupJobPhase) => void
}

/**
 * Workspace backup zip: a consistent copy of `workspace.db` (conversations, bots, memory, procedures, logs),
 * readable JSON of bots, memory notes and procedures and, when asked, `/workspace` as a tar.gz. Secrets
 * (system credential store) are never included. Written to `<path>.partial` and renamed at the end: a failed
 * backup leaves no zip behind.
 */
export async function writeBackupZip(input: WriteBackupInput): Promise<{ path: string; bytes: number }> {
  requireTarget(input.path, '.zip')
  const partial = `${input.path}.partial`
  const dir = await mkdtemp(join(tmpdir(), 'milibot-backup-'))
  let zip: ZipWriter | null = null
  try {
    input.onPhase?.('database')
    await input.db.backup(join(dir, 'workspace.db'))
    const exports = readableExports(input.db)
    zip = await ZipWriter.create(partial, new Date(input.now))
    const contents = ['workspace.db', ...exports.map(([name]) => name)]
    if (existsSync(input.knowledgeDir)) contents.push(KNOWLEDGE_PREFIX)
    const skills = await skillFiles(input.skillsDir)
    if (skills.length) contents.push(SKILLS_PREFIX)
    if (input.workspace) contents.push(WORKSPACE_ENTRY)
    await zip.addBuffer(
      'manifest.json',
      JSON.stringify(
        {
          format: BACKUP_FORMAT,
          formatVersion: 1,
          workspace: input.workspaceName,
          exportedAt: new Date(input.now).toISOString(),
          milibotVersion: input.version,
          contents,
          ...(input.workspace ? { workspaceExcludes: input.workspace.excludes } : {}),
          notIncluded: [
            'API keys and tokens (system credential store)',
            input.workspace
              ? 'Programs installed in the VM (system disk)'
              : 'VM disks (/workspace, programs)',
          ],
        },
        null,
        2,
      ),
    )
    await zip.addStream('workspace.db', createReadStream(join(dir, 'workspace.db')), { deflate: true })
    for (const [name, value] of exports)
      await zip.addBuffer(name, JSON.stringify(value, null, 2), { deflate: true })
    for (const file of await knowledgeFiles(input.knowledgeDir))
      await zip.addStream(`${KNOWLEDGE_PREFIX}${file}`, createReadStream(join(input.knowledgeDir, file)), {
        deflate: true,
      })
    for (const file of skills)
      await zip.addStream(`${SKILLS_PREFIX}${file}`, createReadStream(join(input.skillsDir, file)), {
        deflate: true,
      })
    if (input.workspace) {
      input.onPhase?.('workspace')
      const { onBytes } = input.workspace
      const tar = await input.workspace.open()
      const gzip = createGzip({ level: 6 })
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          onBytes?.(chunk.length)
          callback(null, chunk)
        },
      })
      const compressing = pipeline(tar, counter, gzip).catch((err: unknown) => {
        gzip.destroy(err as Error)
      })
      await zip.addStream(WORKSPACE_ENTRY, gzip)
      await compressing
    }
    input.onPhase?.('finishing')
    await zip.finish()
    zip = null
    await rename(partial, input.path)
    return { path: input.path, bytes: (await stat(input.path)).size }
  } catch (err) {
    await zip?.abort()
    await rm(partial, { force: true })
    throw err
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Files of the knowledge base, relative to its folder (`<docId>/original.pdf`, `<docId>/content.md`). */
async function knowledgeFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const docId of (await readdir(dir)).sort()) {
    if (docId.startsWith('.')) continue
    const docDir = join(dir, docId)
    if (!(await stat(docDir)).isDirectory()) continue
    for (const name of (await readdir(docDir)).sort()) {
      if (name.endsWith('.partial')) continue
      if ((await stat(join(docDir, name))).isFile()) out.push(`${docId}/${name}`)
    }
  }
  return out
}

/** Files of the skill folders, relative to `<wsDir>/skills` (hidden staging folders and symlinks left out). */
async function skillFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const visit = async (relative: string) => {
    for (const entry of (await readdir(join(dir, relative), { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!relative && entry.name.startsWith('.')) continue
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) out.push(path)
    }
  }
  await visit('')
  return out
}

/** Where a `skills/…` entry of a backup goes, or null when its path could escape the skills folder. */
export function skillEntryTarget(
  wsDir: string,
  entryName: string,
  pathImpl: PlatformPath = nodePath,
): string | null {
  if (!entryName.startsWith(SKILLS_PREFIX) || entryName.endsWith('/')) return null
  const parts = entryName.slice(SKILLS_PREFIX.length).split('/')
  if (parts.length < 2 || parts[0]?.startsWith('.')) return null
  return containedJoin(pathImpl.join(wsDir, 'skills'), parts, pathImpl)
}

/** Where a `knowledge/<doc>/<file>` entry of a backup goes, or null when it could escape that folder. */
export function knowledgeEntryTarget(
  wsDir: string,
  entryName: string,
  pathImpl: PlatformPath = nodePath,
): string | null {
  if (!entryName.startsWith(KNOWLEDGE_PREFIX) || entryName.endsWith('/')) return null
  const parts = entryName.slice(KNOWLEDGE_PREFIX.length).split('/')
  if (parts.length !== 2) return null
  return containedJoin(pathImpl.join(wsDir, 'knowledge'), parts, pathImpl)
}

interface Manifest {
  format?: unknown
  workspace?: unknown
  exportedAt?: unknown
  milibotVersion?: unknown
}

function notABackup(message = 'This file is not a Milibot backup'): DaemonError {
  return new DaemonError('validation_failed', message, { reason: 'not_a_backup' })
}

async function openBackup(path: string): Promise<{ reader: ZipReader; manifest: Manifest }> {
  if (!isAbsolute(path) || !existsSync(path))
    throw new DaemonError('not_found', `Backup not found: ${path}`, { reason: 'file_missing' })
  let reader: ZipReader
  let manifest: Manifest
  try {
    reader = await ZipReader.open(path)
    manifest = JSON.parse((await reader.read('manifest.json')).toString('utf8')) as Manifest
  } catch (err) {
    if (err instanceof ZipFormatError || err instanceof SyntaxError) throw notABackup()
    throw err
  }
  if (manifest.format !== BACKUP_FORMAT || !reader.entry('workspace.db')) throw notABackup()
  return { reader, manifest }
}

export async function inspectBackup(path: string): Promise<BackupInfo> {
  const { reader, manifest } = await openBackup(path)
  const list = await reader
    .read('bots.json')
    .then((data) => JSON.parse(data.toString('utf8')) as unknown)
    .catch(() => null)
  const bots = Array.isArray(list) ? list.length : 0
  return {
    workspaceName: typeof manifest.workspace === 'string' ? manifest.workspace : '',
    exportedAt: typeof manifest.exportedAt === 'string' ? manifest.exportedAt : null,
    milibotVersion: typeof manifest.milibotVersion === 'string' ? manifest.milibotVersion : null,
    workspaceBytes: reader.entry(WORKSPACE_ENTRY)?.compressedSize ?? null,
    bots,
  }
}

/** Settings that describe the old VM or credential store; the imported workspace starts without them. */
const STALE_SETTING_PATTERNS = [
  ...CLI_ENGINES.flatMap((engine) => cliKeys(engine).lane('%')),
  'ssh.public_key',
  'github.account',
  BACKUP_RESTORE_KEY,
]

/** Extracts the database of a backup to `dbPath` (a workspace being created, no runtime yet). */
export async function extractBackupDb(
  path: string,
  dbPath: string,
): Promise<{ hasWorkspace: boolean; bytes: number }> {
  const { reader } = await openBackup(path)
  try {
    await reader.extract('workspace.db', dbPath)
  } catch (err) {
    if (err instanceof ZipFormatError) throw notABackup(`The backup is damaged: ${err.message}`)
    throw err
  }
  // Knowledge base files go next to the database; documents whose files are not in the backup are marked
  // failed (`file_missing`) when the runtime starts.
  const wsDir = dirname(dbPath)
  for (const entry of reader.entries) {
    const target = knowledgeEntryTarget(wsDir, entry.name)
    if (!target) continue
    await mkdir(dirname(target), { recursive: true })
    await reader.extract(entry.name, target)
  }
  for (const entry of reader.entries) {
    const target = skillEntryTarget(wsDir, entry.name)
    if (!target) continue
    await mkdir(dirname(target), { recursive: true })
    await reader.extract(entry.name, target)
  }
  return {
    hasWorkspace: reader.entry(WORKSPACE_ENTRY) !== null,
    bytes: reader.entry(WORKSPACE_ENTRY)?.compressedSize ?? 0,
  }
}

/**
 * Prepares an imported database for its new workspace: it goes through the setup again (API keys are not in
 * backups and the VM is new), sessions of the old VM are forgotten, deleted bots have nothing to remove and
 * `/workspace` (if in the backup) is restored once the new VM runs.
 */
export function prepareImportedDb(
  db: Db,
  input: { backupPath: string; hasWorkspace: boolean; workspaceBytes: number; now: number },
): void {
  const setSetting = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
  db.transaction(() => {
    for (const pattern of STALE_SETTING_PATTERNS)
      db.prepare('DELETE FROM settings WHERE key LIKE ?').run(pattern)
    setSetting.run(SETUP_PENDING_KEY, 'true', input.now)
    setSetting.run(SETUP_VM_PENDING_KEY, 'true', input.now)
    db.prepare(
      'UPDATE bots SET vm_removed_at = ? WHERE deleted_at IS NOT NULL AND vm_removed_at IS NULL',
    ).run(input.now)
    if (input.hasWorkspace) {
      const restore: BackupRestore = {
        status: 'pending',
        path: input.backupPath,
        bytesDone: 0,
        bytesTotal: input.workspaceBytes,
        error: null,
        updatedAt: input.now,
      }
      setSetting.run(BACKUP_RESTORE_KEY, JSON.stringify(restore), input.now)
    }
  })()
}
