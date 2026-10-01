import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'

import {
  looksLikeScript,
  parseSkillMd,
  safeSkillPath,
  type SkillProblem,
  slugifySkillName,
  withSkillName,
} from '@milibot/agent'
import {
  type LogFn,
  SKILL_LIMITS,
  type SkillImportCandidate,
  type SkillOrigin,
  type SkillSource,
} from '@milibot/shared'

import { DaemonError } from '../../../errors'
import { ZipReader } from '../../../util/zip'
import { SKIPPED_NAMES, walk } from '../library'

/** Files looked at when searching a folder or archive for skills. */
const MAX_TREE_FILES = 20_000
/** Never searched for a SKILL.md (a skill's own files follow `SKIPPED_NAMES`). */
const DISCOVERY_SKIPPED = new Set([...SKIPPED_NAMES, 'vendor', 'dist', '__MACOSX'])
const S_IFMT = 0o170000
const S_IFLNK = 0o120000

interface ImportFile {
  /** Relative, `/`-separated. */
  path: string
  size: number
  executable: boolean
  read(): Promise<Buffer>
}

/** A skill folder found in a source. */
export interface Found {
  key: string
  /** Name used when SKILL.md has none. */
  folderName: string
  /** Relative to the skill folder. */
  files: ImportFile[]
  origin: SkillOrigin
}

export interface Prepared {
  candidate: SkillImportCandidate
  found: Found
  /** SKILL.md as it will be written (name repaired when needed). */
  skillMd: string | null
}

/** A skill of the library as the importer sees it. */
export interface ImportTarget {
  id: string
  slug: string
  source: SkillSource
  origin: SkillOrigin | null
}

export function validation(
  message: string,
  reason: string,
  extra: Record<string, unknown> = {},
): DaemonError {
  return new DaemonError('validation_failed', message, { reason, ...extra })
}

/**
 * Folders holding a SKILL.md among `paths` (relative, `/`-separated), limited to `within`. A skill folder
 * takes everything below it, so only the outermost ones count. `''` is the root.
 */
export function discoverSkillDirs(paths: string[], within: string | null = null): string[] {
  const scope = within?.replace(/^\/+|\/+$/g, '') || ''
  const dirs = new Set<string>()
  for (const path of paths) {
    const parts = path.split('/')
    if (parts.at(-1) !== 'SKILL.md') continue
    if (parts.slice(0, -1).some((p) => DISCOVERY_SKIPPED.has(p))) continue
    const dir = parts.slice(0, -1).join('/')
    if (scope && dir !== scope && !dir.startsWith(`${scope}/`)) continue
    dirs.add(dir)
  }
  const sorted = [...dirs].sort((a, b) => a.length - b.length || a.localeCompare(b))
  const kept: string[] = []
  for (const dir of sorted) if (!kept.some((k) => k === '' || dir.startsWith(`${k}/`))) kept.push(dir)
  return kept.sort()
}

export function under(files: ImportFile[], dir: string): ImportFile[] {
  if (!dir) return files
  const prefix = `${dir}/`
  return files
    .filter((f) => f.path.startsWith(prefix))
    .map((f) => ({ ...f, path: f.path.slice(prefix.length) }))
}

function sameOrigin(a: SkillOrigin | null, b: SkillOrigin): boolean {
  if (!a || a.kind !== b.kind || (a.path ?? '') !== (b.path ?? '')) return false
  if (a.kind === 'github') return a.repo === b.repo
  if (a.kind === 'workspace') return a.workspaceId === b.workspaceId
  return a.localPath === b.localPath
}

/** Files of a zip: unsafe names (absolute, `..`, backslashes, drive letters) and symlinks are left out. */
export function zipFiles(
  reader: ZipReader,
  stripFirst: boolean,
): { files: ImportFile[]; rejected: string[] } {
  const files: ImportFile[] = []
  const rejected: string[] = []
  for (const entry of reader.entries) {
    if (entry.name.endsWith('/')) continue
    if ((entry.mode & S_IFMT) === S_IFLNK) {
      rejected.push(entry.name)
      continue
    }
    const raw = stripFirst ? entry.name.split('/').slice(1).join('/') : entry.name
    const path = /^[A-Za-z]:/.test(raw) ? null : safeSkillPath(raw)
    if (!path || raw.startsWith('/') || raw.split('/').includes('..')) {
      if (raw) rejected.push(entry.name)
      continue
    }
    files.push({
      path,
      size: entry.size,
      executable: (entry.mode & 0o111) !== 0,
      read: async () => {
        const data = await reader.read(entry.name)
        if (data.length !== entry.size) throw new Error(`${path} is corrupted`)
        return data
      },
    })
    if (files.length > MAX_TREE_FILES)
      throw validation(`The archive has more than ${MAX_TREE_FILES} files.`, 'too_many_files')
  }
  return { files, rejected }
}

function localFiles(root: string): ImportFile[] {
  const { files, tooMany } = walk(root, MAX_TREE_FILES)
  if (tooMany) throw validation(`The folder has more than ${MAX_TREE_FILES} files.`, 'too_many_files')
  return files.map((f) => ({
    path: f.path,
    size: f.size,
    executable: (f.mode & 0o111) !== 0,
    read: () => readFile(join(root, ...f.path.split('/'))),
  }))
}

const isArchive = (path: string) => /\.(zip|skill)$/i.test(path)

/** Skills in local paths: folders, `.zip`/`.skill` archives and single SKILL.md files. */
export async function fromPaths(paths: string[], log?: LogFn): Promise<Found[]> {
  const found: Found[] = []
  for (const path of paths) {
    if (!isAbsolute(path)) throw validation(`Not an absolute path: ${path}`, 'invalid_path')
    let info
    try {
      info = await stat(path)
    } catch {
      throw new DaemonError('not_found', `Not found: ${path}`, { reason: 'path_not_found', path })
    }
    if (info.isDirectory()) {
      const files = localFiles(path)
      for (const dir of discoverSkillDirs(files.map((f) => f.path)))
        found.push({
          key: dir ? join(path, dir) : path,
          folderName: dir ? basename(dir) : basename(path),
          files: under(files, dir),
          origin: { kind: 'path', localPath: path, path: dir },
        })
    } else if (info.isFile() && isArchive(path)) {
      let reader: ZipReader
      try {
        reader = await ZipReader.open(path)
      } catch {
        throw validation(`Not a zip file: ${path}`, 'not_a_zip', { path })
      }
      const { files, rejected } = zipFiles(reader, false)
      if (rejected.length) log?.('warn', 'skill import: unsafe zip entries skipped', { rejected })
      for (const dir of discoverSkillDirs(files.map((f) => f.path)))
        found.push({
          key: `${path}#${dir || '.'}`,
          folderName: dir ? basename(dir) : basename(path, extname(path)),
          files: under(files, dir),
          origin: { kind: 'zip', localPath: path, path: dir },
        })
    } else if (info.isFile() && /\.md$/i.test(path)) {
      found.push({
        key: path,
        folderName:
          basename(path).toLowerCase() === 'skill.md'
            ? basename(dirname(path))
            : basename(path, extname(path)),
        files: [{ path: 'SKILL.md', size: info.size, executable: false, read: () => readFile(path) }],
        origin: { kind: 'path', localPath: path, path: null },
      })
    } else {
      throw validation(`Not a folder, SKILL.md or .zip: ${path}`, 'unsupported_file', { path })
    }
  }
  return found
}

/** Skills of another workspace's skills folder (`workspaceDir` is this workspace's own). */
export function fromWorkspace(workspaceDir: string, workspaceId: string): Found[] {
  const own = basename(workspaceDir)
  if (!/^[A-Za-z0-9_-]+$/.test(workspaceId) || workspaceId === own)
    throw validation('Choose another workspace.', 'invalid_workspace')
  const other = join(dirname(workspaceDir), workspaceId)
  if (!existsSync(other))
    throw new DaemonError('not_found', `workspace not found: ${workspaceId}`, {
      reason: 'workspace_not_found',
    })
  const root = join(other, 'skills')
  if (!existsSync(root)) return []
  const files = localFiles(root).filter((f) => !f.path.startsWith('.'))
  return discoverSkillDirs(files.map((f) => f.path))
    .filter((dir) => dir !== '')
    .map((dir) => ({
      key: dir,
      folderName: basename(dir),
      files: under(files, dir),
      origin: { kind: 'workspace', workspaceId, path: dir },
    }))
}

/**
 * A found skill checked against the limits and SKILL.md rules, with the name it will take: an update of the
 * same import, or a free name when it clashes with a built-in or another skill (`reserved`: names already
 * taken by other candidates of the same scan).
 */
export async function prepare(
  found: Found,
  targets: ImportTarget[],
  reserved: Set<string>,
): Promise<Prepared> {
  const bytes = found.files.reduce((sum, f) => sum + f.size, 0)
  let error: SkillProblem | null = null
  let name = slugifySkillName(found.folderName)
  let description = ''
  let skillMd: string | null = null
  if (found.files.length > SKILL_LIMITS.files)
    error = {
      error: `The skill has more than ${SKILL_LIMITS.files} files.`,
      code: 'too_many_files',
      params: { max: SKILL_LIMITS.files },
    }
  else if (bytes > SKILL_LIMITS.bytes)
    error = {
      error: `The skill is larger than ${SKILL_LIMITS.bytes / 1024 / 1024} MB.`,
      code: 'too_large',
      params: { mb: SKILL_LIMITS.bytes / 1024 / 1024 },
    }
  const file = found.files.find((f) => f.path === 'SKILL.md')
  if (!error && !file) error = { error: 'SKILL.md is missing.', code: 'skill_md_missing', params: null }
  else if (!error && file && file.size > SKILL_LIMITS.skillMdBytes)
    error = {
      error: `SKILL.md is larger than ${SKILL_LIMITS.skillMdBytes / 1024} KB.`,
      code: 'skill_md_too_large',
      params: { kb: SKILL_LIMITS.skillMdBytes / 1024 },
    }
  else if (!error && file) {
    skillMd = (await file.read()).toString('utf8')
    let parsed = parseSkillMd(skillMd)
    if (!parsed.ok && parsed.error.startsWith('name:')) {
      const repaired = withSkillName(skillMd, name)
      const again = repaired ? parseSkillMd(repaired) : null
      if (repaired && again) {
        skillMd = repaired
        parsed = again
      }
    }
    if (parsed.ok) {
      name = parsed.meta.name
      description = parsed.meta.description
    } else error = { error: parsed.error, code: parsed.code, params: parsed.params }
  }
  const slugs = new Set(targets.map((t) => t.slug))
  const freeSlug = (base: string) => {
    for (let n = 2; ; n++) {
      const suffix = `-${n}`
      const slug = `${base.slice(0, SKILL_LIMITS.nameLength - suffix.length)}${suffix}`
      if (!slugs.has(slug) && !reserved.has(slug)) return slug
    }
  }
  const existing = targets.find((t) => t.slug === name) ?? null
  let conflict: SkillImportCandidate['conflict'] = 'none'
  let importAs = name
  if (existing?.source === 'builtin') {
    conflict = 'similar_builtin'
    importAs = freeSlug(name)
  } else if (
    existing &&
    !reserved.has(name) &&
    existing.source === 'import' &&
    sameOrigin(existing.origin, found.origin)
  ) {
    conflict = 'update'
  } else if (existing || reserved.has(name)) {
    conflict = 'name_taken'
    importAs = freeSlug(name)
  }
  if (!error) reserved.add(importAs)
  return {
    found,
    skillMd,
    candidate: {
      path: found.key,
      name,
      description,
      files: found.files.length,
      bytes,
      hasScripts: found.files.some((f) => looksLikeScript(f.path, new Uint8Array(), f.executable)),
      conflict,
      importAs,
      existingSkillId: existing?.id ?? null,
      error: error?.error ?? null,
      errorCode: error?.code ?? null,
      errorParams: error?.params ?? null,
    },
  }
}
