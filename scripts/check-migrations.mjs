#!/usr/bin/env node
// Usage: node scripts/check-migrations.mjs [baseRef]   (default: main)
// Fails when a migration present at baseRef was edited or removed, or when more than one migration was added
// to a database since baseRef. On the root commit (e.g. `HEAD~1` does not exist) the base has no migrations.
// Migration files are loaded standalone through Node's type stripping, so they may only use `import type`.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const baseRef = process.argv[2] ?? 'main'
const DB_DIR = 'apps/daemon/src/db'
const DATABASES = ['app', 'workspace']
const MIGRATION_FILE = /^\d+_.+\.ts$/

function git(args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function exists(ref, path) {
  try {
    git(['cat-file', '-e', `${ref}:${path}`])
    return true
  } catch {
    return false
  }
}

async function load(path) {
  try {
    return await import(pathToFileURL(path).href)
  } catch (err) {
    throw new Error(`cannot load ${path} (migration files may only use \`import type\`): ${err.message}`, {
      cause: err,
    })
  }
}

function describeMigration(migration) {
  const up = typeof migration.up === 'function' ? migration.up.toString() : migration.up
  return JSON.stringify({ name: migration.name, foreignKeysOff: migration.foreignKeysOff ?? false, up })
}

async function loadFolder(dir) {
  const files = readdirSync(dir).filter((file) => MIGRATION_FILE.test(file))
  return Promise.all(files.map(async (file) => (await load(join(dir, file))).default))
}

async function baseMigrations(db, scratch) {
  const folder = `${DB_DIR}/migrations/${db}`
  if (!base || !exists(base, folder)) return []
  const target = join(scratch, db)
  mkdirSync(target)
  writeFileSync(join(target, 'package.json'), '{"type":"module"}\n')
  const files = git(['ls-tree', '--name-only', `${base}:${folder}`])
    .split('\n')
    .filter((file) => MIGRATION_FILE.test(file))
  for (const file of files) writeFileSync(join(target, file), git(['show', `${base}:${folder}/${file}`]))
  return loadFolder(target)
}

function compare(db, before, after) {
  const problems = []
  const current = new Map(after.map((m) => [m.version, m]))
  for (const migration of before) {
    const now = current.get(migration.version)
    if (!now) problems.push(`${db} migration ${migration.version}_${migration.name} was removed`)
    else if (describeMigration(now) !== describeMigration(migration))
      problems.push(
        `${db} migration ${migration.version}_${migration.name} was edited; a migration already on ${baseName} ` +
          'is never changed: undo the edit and add a new migration instead',
      )
  }
  const known = new Set(before.map((m) => m.version))
  const added = after.filter((m) => !known.has(m.version)).sort((a, b) => a.version - b.version)
  if (added.length > 1)
    problems.push(
      `${db} gained ${added.length} migrations since ${baseName} (${added.map((m) => `${m.version}_${m.name}`).join(', ')}); ` +
        'a commit/PR adds at most one per database: merge them into one',
    )
  return { problems, added }
}

function resolves(ref) {
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    return true
  } catch {
    return false
  }
}

let base = baseRef
if (!resolves(base)) {
  if (resolves('HEAD^')) {
    console.error(`check-migrations: unknown git ref "${base}"`)
    process.exit(2)
  }
  console.log(
    `check-migrations: "${base}" does not exist and HEAD is a root commit; comparing against no migrations`,
  )
  base = null
}
const baseName = base ?? 'the empty base'

const scratch = mkdtempSync(join(tmpdir(), 'milibot-check-migrations-'))
const problems = []
try {
  for (const db of DATABASES) {
    const before = await baseMigrations(db, scratch)
    const after = await loadFolder(join(root, DB_DIR, 'migrations', db))
    const result = compare(db, before, after)
    problems.push(...result.problems)
    const added = result.added.map((m) => `${m.version}_${m.name}`).join(', ') || 'none'
    console.log(`${db}: ${before.length} migration(s) at ${baseName}, new: ${added}`)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (problems.length) {
  console.error(`\ncheck-migrations failed against ${baseName}:`)
  for (const problem of problems) console.error(`- ${problem}`)
  process.exit(1)
}
