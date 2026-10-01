import { createHash } from 'node:crypto'
import { type FSWatcher, lstatSync, mkdirSync, readdirSync, readFileSync, watch } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { looksLikeScript, parseSkillMd, type SkillMeta, skillNameError } from '@milibot/agent'
import { estimateTokens, type LogFn, SKILL_LIMITS, type SkillFile } from '@milibot/shared'

import { findUp } from '../../util/fs'

/** One skill folder as read from disk. */
export interface ScannedSkill {
  /** Folder name. */
  slug: string
  dir: string
  builtin: boolean
  skillMd: string | null
  meta: SkillMeta | null
  body: string
  /** Every file, SKILL.md included, sorted by path. */
  files: SkillFile[]
  bytes: number
  /** Content of every file (paths, executable bits, bytes): what the VM mirror compares. */
  hash: string
  tokens: number
  hasScripts: boolean
  error: string | null
}

/** Folders never taken into a skill (version control, dependencies, caches, macOS metadata). */
export const SKIPPED_NAMES = new Set(['.git', 'node_modules', '__pycache__', '.DS_Store', '.venv'])

interface WalkedFile {
  path: string
  size: number
  mtimeMs: number
  mode: number
}

/** Regular files under `dir` (symlinks and special files are ignored); stops past `limit`. */
export function walk(dir: string, limit: number): { files: WalkedFile[]; tooMany: boolean } {
  const files: WalkedFile[] = []
  const visit = (relative: string): boolean => {
    let names: string[]
    try {
      names = readdirSync(join(dir, relative))
    } catch {
      return true
    }
    for (const name of names.sort()) {
      if (SKIPPED_NAMES.has(name)) continue
      const path = relative ? `${relative}/${name}` : name
      let info
      try {
        info = lstatSync(join(dir, path))
      } catch {
        continue
      }
      if (info.isDirectory()) {
        if (!visit(path)) return false
      } else if (info.isFile()) {
        files.push({ path, size: info.size, mtimeMs: info.mtimeMs, mode: info.mode })
        if (files.length > limit) return false
      }
    }
    return true
  }
  const complete = visit('')
  return { files, tooMany: !complete }
}

function readSkill(
  slug: string,
  dir: string,
  builtin: boolean,
  walked: WalkedFile[],
  tooMany: boolean,
): ScannedSkill {
  const skill: ScannedSkill = {
    slug,
    dir,
    builtin,
    skillMd: null,
    meta: null,
    body: '',
    files: [],
    bytes: walked.reduce((sum, f) => sum + f.size, 0),
    hash: '',
    tokens: 0,
    hasScripts: false,
    error: null,
  }
  const fail = (error: string) => ({ ...skill, error })
  if (tooMany) return fail(`The skill has more than ${SKILL_LIMITS.files} files.`)
  if (skill.bytes > SKILL_LIMITS.bytes)
    return fail(`The skill is larger than ${SKILL_LIMITS.bytes / 1024 / 1024} MB.`)
  const hash = createHash('sha256')
  for (const file of walked) {
    let bytes: Buffer
    try {
      bytes = readFileSync(join(dir, file.path))
    } catch {
      continue
    }
    const executable = (file.mode & 0o111) !== 0 || (bytes[0] === 0x23 && bytes[1] === 0x21)
    if (looksLikeScript(file.path, bytes.subarray(0, 2), executable)) skill.hasScripts = true
    skill.files.push({ path: file.path, bytes: bytes.length, executable })
    hash.update(`${file.path}\0${executable ? 'x' : '-'}\0${bytes.length}\0`).update(bytes)
    if (file.path === 'SKILL.md') skill.skillMd = bytes.toString('utf8')
  }
  skill.hash = hash.digest('hex').slice(0, 32)
  const nameError = skillNameError(slug)
  if (nameError) return fail(`Folder name: ${nameError}`)
  if (skill.skillMd === null) return fail('SKILL.md is missing.')
  const parsed = parseSkillMd(skill.skillMd)
  if (!parsed.ok) return fail(parsed.error)
  skill.meta = parsed.meta
  skill.body = parsed.body
  skill.tokens = estimateTokens(parsed.body)
  if (parsed.meta.name !== slug)
    return fail(`The name in SKILL.md ("${parsed.meta.name}") must match the folder name ("${slug}").`)
  return skill
}

interface CacheEntry {
  signature: string
  skill: ScannedSkill
}

export interface SkillLibraryDeps {
  /** `<wsDir>/skills`: the workspace's own skills (created, imported, made by bots, copied in). */
  userDir: string
  /** Skills shipped with the app (read-only). */
  builtinDir: string | null
  /** Something changed on disk (debounced `fs.watch`); the next `scan` reads it. */
  onChange?: () => void
  log?: LogFn
}

/**
 * The skill folders on disk. Each scan lists the folders and stats their files; a folder is read again only
 * when its file list, sizes or modification times changed. `fs.watch` only hints that something changed.
 */
export class SkillLibrary {
  private readonly cache = new Map<string, CacheEntry>()
  private watcher: FSWatcher | null = null
  private debounce: NodeJS.Timeout | null = null
  private last: { builtins: ScannedSkill[]; user: ScannedSkill[] } | null = null
  private lastAt = 0
  private dirty = true

  constructor(private readonly deps: SkillLibraryDeps) {}

  get userDir(): string {
    return this.deps.userDir
  }

  /** Current folders; reuses the previous scan for a second unless something changed. */
  scan(force = false): { builtins: ScannedSkill[]; user: ScannedSkill[] } {
    const now = Date.now()
    if (!force && !this.dirty && this.last && now - this.lastAt < 1000) return this.last
    this.dirty = false
    this.lastAt = now
    this.last = {
      builtins: this.deps.builtinDir ? this.scanDir(this.deps.builtinDir, true) : [],
      user: this.scanDir(this.deps.userDir, false),
    }
    return this.last
  }

  markDirty(): void {
    this.dirty = true
  }

  private scanDir(root: string, builtin: boolean): ScannedSkill[] {
    let names: string[]
    try {
      names = readdirSync(root)
    } catch {
      return []
    }
    const out: ScannedSkill[] = []
    const seen = new Set<string>()
    for (const name of names.sort()) {
      if (name.startsWith('.') || SKIPPED_NAMES.has(name)) continue
      const dir = join(root, name)
      try {
        if (!lstatSync(dir).isDirectory()) continue
      } catch {
        continue
      }
      seen.add(dir)
      const { files, tooMany } = walk(dir, SKILL_LIMITS.files)
      const signature = `${tooMany}|${files.map((f) => `${f.path}:${f.size}:${f.mtimeMs}:${f.mode}`).join('|')}`
      const cached = this.cache.get(dir)
      if (cached?.signature === signature) {
        out.push(cached.skill)
        continue
      }
      const skill = readSkill(name, dir, builtin, files, tooMany)
      this.cache.set(dir, { signature, skill })
      out.push(skill)
    }
    for (const dir of this.cache.keys()) if (dirname(dir) === root && !seen.has(dir)) this.cache.delete(dir)
    return out
  }

  watch(): void {
    if (this.watcher) return
    try {
      mkdirSync(this.deps.userDir, { recursive: true })
      this.watcher = watch(this.deps.userDir, { recursive: true }, (_event, file) => {
        if (typeof file === 'string' && file.split('/')[0]?.startsWith('.')) return
        this.dirty = true
        if (this.debounce) clearTimeout(this.debounce)
        this.debounce = setTimeout(() => {
          this.debounce = null
          this.deps.onChange?.()
        }, 300)
      })
      this.watcher.on('error', (err) => {
        this.deps.log?.('warn', 'skills folder watch failed', { err: err.message })
        this.watcher?.close()
        this.watcher = null
      })
    } catch (err) {
      this.deps.log?.('warn', 'skills folder not watched', { err: (err as Error).message })
    }
  }

  close(): void {
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = null
    this.watcher?.close()
    this.watcher = null
  }
}

/**
 * The built-in skills: `packages/agent/skills` in the repository, `Resources/assets/skills` in the packaged
 * app (`MILIBOT_BUILTIN_SKILLS` replaces both, see `RuntimeConfig`).
 */
export function defaultBuiltinSkillsDir(): string | null {
  const start = dirname(fileURLToPath(import.meta.url))
  return findUp(start, join('packages', 'agent', 'skills')) ?? findUp(start, join('assets', 'skills'))
}
