import { posix } from 'node:path'

import { DaemonError } from '../../errors'
import { parseKeyValueLines } from '../vm'

export { FOLDER_SCRIPT } from './scripts/folder.generated'

export const WORKSPACE_DIR = '/workspace'
export const SESSIONS_DIR = `${WORKSPACE_DIR}/sessions`

const RESERVED: Array<{ dir: string; why: string }> = [
  { dir: `${WORKSPACE_DIR}/.milibot`, why: "holds Milibot's own data" },
  { dir: `${WORKSPACE_DIR}/worktrees`, why: 'holds the repository worktrees: pass `repo` instead' },
  { dir: `${WORKSPACE_DIR}/repos`, why: 'holds the shared clones: pass `repo` for a worktree of one' },
]

const isWithin = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`)

/**
 * The folder a work session without a repository is asked to work in, normalized: an absolute path inside
 * /workspace, outside the folders Milibot manages. Throws a `validation_failed` DaemonError the bot can read.
 */
export function sessionFolder(value: string): string {
  const raw = value.trim()
  if (!raw.startsWith('/'))
    throw invalid(
      `"${raw}" is not an absolute path: name the folder under /workspace (e.g. /workspace/my-app).`,
    )
  if (raw.length > 500 || [...raw].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
    throw invalid('the folder path is not valid.')
  const folder = posix.normalize(raw).replace(/\/+$/, '')
  if (!folder.startsWith(`${WORKSPACE_DIR}/`))
    throw invalid(`${folder} is outside /workspace: work sessions work in a folder inside /workspace.`)
  for (const { dir, why } of RESERVED)
    if (isWithin(folder, dir)) throw invalid(`${folder} cannot be used: ${dir} ${why}.`)
  if (folder === SESSIONS_DIR) throw invalid(`${SESSIONS_DIR} holds the folders of every work session.`)
  return folder
}

/** A chosen folder may not overlap the folder of another open session (their changes would mix). */
export function assertFolderFree(
  folder: string,
  openFolders: Array<{ cwd: string | null; title: string }>,
): void {
  for (const other of openFolders) {
    if (!other.cwd || other.cwd === WORKSPACE_DIR) continue
    if (isWithin(folder, other.cwd) || isWithin(other.cwd, folder))
      throw new DaemonError(
        'conflict',
        `The folder ${folder} overlaps ${other.cwd}, where the open work session "${other.title}" works: ` +
          'finish that session first or choose another folder.',
      )
  }
}

/** Checks where `FOLDER_SCRIPT` found the folder really is (a symlink may point elsewhere). */
export function checkPreparedFolder(folder: string, stdout: string): void {
  const values = parseKeyValueLines(stdout)
  if (values.OUTSIDE) throw invalid(`${folder} leads outside /workspace.`)
  if (values.REL) sessionFolder(`${WORKSPACE_DIR}/${values.REL}`)
}

function invalid(message: string): DaemonError {
  return new DaemonError('validation_failed', `Invalid folder: ${message}`)
}
