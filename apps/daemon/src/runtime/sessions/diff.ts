import { ANTIGRAVITY_TOOLS, CODEX_TOOLS } from '@milibot/agent/cli'
import type {
  SessionChangedFile,
  SessionChangesUnavailable,
  SessionChangeTotals,
  SessionFileStatus,
} from '@milibot/shared'

import { parseKeyValueLines } from '../vm'
import { BASELINE_SCRIPT } from './scripts/baseline.generated'
import { CHANGES_SCRIPT } from './scripts/changes.generated'
import { GIT_SCRIPT } from './scripts/git.generated'
import { IMAGE_SCRIPT } from './scripts/image.generated'

/** A folder without git bigger than this (ignored files aside) gets no snapshot (its changes stay unavailable). */
export const SHADOW_MAX_FILES = 20_000
export const SHADOW_MAX_KB = 200 * 1024
export const MAX_PATCH_BYTES = 400 * 1024
/** Larger images get no preview (only their size). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** Every patch saved when a session finishes, together. */
export const MAX_SAVED_PATCHES_BYTES = 2 * 1024 * 1024
/** Files kept with the stored changes (the bot's state block shows fewer). */
export const STORED_FILES = 200

/** Tools that may change files in the session's folder (native, Claude Code, Codex and Antigravity). */
export const FILE_CHANGING_TOOLS = new Set<string>([
  CODEX_TOOLS.exec,
  CODEX_TOOLS.patch,
  ...Object.values(ANTIGRAVITY_TOOLS),
  'bash',
  'file_write',
  'file_edit',
  'apply_patch',
  'Bash',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
])

export function shadowGitDir(sessionId: string): string {
  return `/workspace/.milibot/sessions/${sessionId}.git`
}

/**
 * Dependency and cache folders of common toolchains, ignored on top of the folder's own `.gitignore` (a fresh
 * project often installs its dependencies before writing one). Files a repository tracks still show.
 */
const DEFAULT_IGNORED = [
  'node_modules/',
  'bower_components/',
  'jspm_packages/',
  '.pnpm-store/',
  '.yarn/cache/',
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  '.turbo/',
  '.parcel-cache/',
  '__pycache__/',
  '*.py[cod]',
  '.venv/',
  'venv/',
  '.tox/',
  '.mypy_cache/',
  '.pytest_cache/',
  '.ruff_cache/',
  '*.egg-info/',
  'vendor/',
  '.bundle/',
  'target/',
  '.gradle/',
  '.dart_tool/',
  'Pods/',
  '.stack-work/',
  '_build/',
  '.terraform/',
  '.cache/',
  '.DS_Store',
]

const withGit = (script: string) => `${GIT_SCRIPT}\n${script}`

/**
 * Scripts over a session's folder, run as its bot (`scripts/`). `baseline`: the commit the session starts from
 * when its folder is a git folder (the empty tree for a repository without commits), else a snapshot commit in
 * a git dir of its own outside the folder. The mode is decided there for good: a `.git` the bot creates later
 * inside a snapshotted folder is never read (git skips `.git` entries). Only files the folder's `.gitignore`
 * keeps count towards the size limit. `changes`: what changed against the baseline through a temporary index
 * (the folder's own index and files are not touched): numstat and name-status with NUL separators, the patch of
 * `FILE_PATH` (plus `OLD_PATH` of a rename), or with `ALL_PATCHES` the patch of every file after a
 * `\0@@FILE\0<path>\0` marker. `image`: an image's bytes at the baseline and in the folder; paths come from
 * `--relative` (relative to the session folder, which may be inside the repository), hence `./`.
 */
export const DIFF_SCRIPTS = {
  baseline: withGit(BASELINE_SCRIPT),
  changes: withGit(CHANGES_SCRIPT),
  image: withGit(IMAGE_SCRIPT),
}

/** Environment every diff script takes besides its own. */
export const DIFF_SCRIPT_ENV = { IGNORED_PATTERNS: DEFAULT_IGNORED.join('\n') }

export interface ImageSide {
  bytes: number
  /** Null when the image is too large to preview. */
  data: Buffer | null
}

/** Output of the `image` script. */
export function parseImageSides(stdout: string): { before: ImageSide | null; after: ImageSide | null } {
  const sides: { before: ImageSide | null; after: ImageSide | null } = { before: null, after: null }
  for (const line of stdout.split('\n')) {
    const match = /^(BEFORE|AFTER) (\d+)(?: (-|[A-Za-z0-9+/=]*))?$/.exec(line.trim())
    if (!match) continue
    const data = match[3] === '-' ? null : Buffer.from(match[3] ?? '', 'base64')
    sides[match[1] === 'BEFORE' ? 'before' : 'after'] = { bytes: Number(match[2]), data }
  }
  return sides
}

export type BaselineResult =
  | { mode: 'git' | 'shadow'; base: string }
  | { error: Extract<SessionChangesUnavailable, 'too_large' | 'failed'> }

export function parseBaseline(stdout: string): BaselineResult {
  const values = parseKeyValueLines(stdout)
  if (values.ERROR === 'too_large') return { error: 'too_large' }
  const mode = values.MODE
  const base = values.BASE ?? ''
  if ((mode === 'git' || mode === 'shadow') && /^[0-9a-f]{7,64}$/.test(base)) return { mode, base }
  return { error: 'failed' }
}

const STATUS_BY_LETTER: Record<string, SessionFileStatus> = {
  A: 'added',
  D: 'deleted',
  M: 'modified',
  T: 'modified',
  U: 'modified',
  R: 'renamed',
  C: 'added',
}

/** A patch cut at `MAX_PATCH_BYTES`, at the end of a line. */
export function cutPatch(patch: string): { patch: string; truncated: boolean } {
  if (Buffer.byteLength(patch, 'utf8') <= MAX_PATCH_BYTES) return { patch, truncated: false }
  const cut = Buffer.from(patch, 'utf8').subarray(0, MAX_PATCH_BYTES).toString('utf8')
  return { patch: cut.slice(0, cut.lastIndexOf('\n') + 1), truncated: true }
}

const TREE_MARKER = '\0@@TREE\0'

/** Where the files of a finished session can be read once its folder is gone. */
export interface SavedTree {
  /** Tree of the folder's files when the patches were saved (written with them). */
  tree: string
  /** The git dir the tree was written to: the repository's common one, or the shadow one. */
  gitDir: string
  /** The session folder's path in the tree ('' or ending in '/'). */
  prefix: string
}

/** The trailer of the `changes` script with ALL_PATCHES; null when it has none. */
export function parseSavedTree(stdout: string): SavedTree | null {
  const at = stdout.lastIndexOf(TREE_MARKER)
  if (at < 0) return null
  const [tree = '', gitDir = '', prefix = ''] = stdout.slice(at + TREE_MARKER.length).split('\0')
  if (!/^[0-9a-f]{7,64}$/.test(tree) || !gitDir.startsWith('/')) return null
  return { tree, gitDir, prefix }
}

/** Output of the `changes` script with `ALL_PATCHES`: the patch of each file (the last one cut when all hit the cap). */
export function parseAllPatches(
  stdout: string,
  maxTotal: number,
): Array<{ path: string; patch: string; truncated: boolean }> {
  const trailer = stdout.lastIndexOf(TREE_MARKER)
  const patches = trailer < 0 ? stdout : stdout.slice(0, trailer)
  const parts = patches.split('\0@@FILE\0').slice(1)
  const full = Buffer.byteLength(patches, 'utf8') >= maxTotal
  return parts.flatMap((part, i) => {
    const end = part.indexOf('\0')
    if (end <= 0) return []
    const cut = cutPatch(part.slice(end + 1))
    const last = i === parts.length - 1
    return [{ path: part.slice(0, end), patch: cut.patch, truncated: cut.truncated || (full && last) }]
  })
}

/** Output of the `changes` script without a file: the changed files, in git's order. */
export function parseChanges(stdout: string): SessionChangedFile[] {
  const separator = stdout.indexOf('\0@@\0')
  if (separator < 0) throw new Error('unexpected git output')
  const numstat = stdout.slice(0, separator).split('\0')
  const nameStatus = stdout.slice(separator + 4).split('\0')

  const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>()
  for (let i = 0; i < numstat.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(numstat[i] as string)
    if (!match) continue
    let path = match[3] as string
    if (!path) {
      path = numstat[i + 2] ?? ''
      i += 2
    }
    const binary = match[1] === '-' && match[2] === '-'
    counts.set(path, {
      additions: binary ? 0 : Number(match[1]),
      deletions: binary ? 0 : Number(match[2]),
      binary,
    })
  }

  const files: SessionChangedFile[] = []
  for (let i = 0; i < nameStatus.length; i++) {
    const code = nameStatus[i] as string
    if (!code) continue
    const letter = code[0] as string
    const status = STATUS_BY_LETTER[letter]
    if (!status) continue
    let path: string
    let oldPath: string | undefined
    if (letter === 'R' || letter === 'C') {
      oldPath = nameStatus[i + 1] ?? ''
      path = nameStatus[i + 2] ?? ''
      i += 2
    } else {
      path = nameStatus[i + 1] ?? ''
      i += 1
    }
    if (!path) continue
    const count = counts.get(path) ?? { additions: 0, deletions: 0, binary: false }
    files.push({ path, ...(letter === 'R' && oldPath ? { oldPath } : {}), status, ...count })
  }
  return files
}

export function changeTotals(files: SessionChangedFile[]): SessionChangeTotals {
  return {
    files: files.length,
    additions: files.reduce((sum, f) => sum + f.additions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0),
  }
}

/** `path +a −d` lines for the bot (at most `max`, then how many more). */
export function diffstatLines(files: SessionChangedFile[], max = 40): string[] {
  const lines = files
    .slice(0, max)
    .map((f) =>
      f.binary
        ? `${f.path} (binary, ${f.status})`
        : `${f.oldPath ? `${f.oldPath} → ` : ''}${f.path} +${f.additions} −${f.deletions}${f.status === 'added' || f.status === 'deleted' ? ` (${f.status})` : ''}`,
    )
  if (files.length > max) lines.push(`… and ${files.length - max} more files`)
  return lines
}

const LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  mdx: 'markdown',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  vue: 'markup',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  dockerfile: 'docker',
  lua: 'lua',
  dart: 'dart',
  ex: 'elixir',
  exs: 'elixir',
  scala: 'scala',
  graphql: 'graphql',
  proto: 'protobuf',
}

/** Highlighting language of a path (by extension; `Dockerfile`/`Makefile` by name). */
export function languageOf(path: string): string | undefined {
  const name = path.split('/').pop()?.toLowerCase() ?? ''
  if (name === 'dockerfile') return 'docker'
  if (name === 'makefile') return 'makefile'
  const dot = name.lastIndexOf('.')
  return dot > 0 ? LANGUAGES[name.slice(dot + 1)] : undefined
}
