import { posix } from 'node:path'

import type { RepoInstructionFile } from '@milibot/agent'
import { REPO_INSTRUCTIONS_FILE_MAX } from '@milibot/agent/prompts'
import type { Bot } from '@milibot/shared'

import { botLinuxUser, type GuestClient } from '../vm'
import { INSTRUCTIONS_SCRIPT } from './scripts/instructions.generated'

const WORKSPACE = '/workspace'
const EXEC_TIMEOUT_MS = 20_000

/** Paths the resolver looks at: absolute, normalized, under `root`, each once. */
function workspacePaths(paths: string[], root: string): string[] {
  const out = new Set<string>()
  for (const path of paths) {
    if (!path.startsWith('/')) continue
    const normal = posix.normalize(path).replace(/\/+$/, '') || '/'
    if (normal === root || normal.startsWith(`${root}/`)) out.add(normal)
  }
  return [...out]
}

function parseFiles(stdout: string): RepoInstructionFile[] {
  const line = stdout.trim().split('\n').pop() ?? ''
  const parsed = JSON.parse(line) as { files?: unknown }
  if (!Array.isArray(parsed.files)) return []
  return parsed.files.flatMap((f: Record<string, unknown>) =>
    typeof f.path === 'string' && typeof f.content === 'string' && typeof f.bytes === 'number'
      ? [
          {
            path: f.path,
            bytes: f.bytes,
            truncated: f.truncated === true,
            content: f.content,
            sameAs: Array.isArray(f.sameAs) ? f.sameAs.filter((p): p is string => typeof p === 'string') : [],
          },
        ]
      : [],
  )
}

/**
 * The CLAUDE.md/AGENTS.md of the repositories of `paths` (see `RepoInstructionsPort`), read in the VM as the
 * bot in one exec, so a file the bot cannot read never reaches it.
 */
export async function readRepoInstructions(
  guest: GuestClient,
  bot: Pick<Bot, 'slug'>,
  paths: string[],
  signal?: AbortSignal,
  root = WORKSPACE,
): Promise<RepoInstructionFile[]> {
  const dirs = workspacePaths(paths, root)
  if (dirs.length === 0) return []
  const result = await guest.exec(
    {
      user: botLinuxUser(bot.slug),
      argv: ['node', '-e', INSTRUCTIONS_SCRIPT],
      cwd: '/',
      stdin: JSON.stringify({ root, dirs, maxBytes: REPO_INSTRUCTIONS_FILE_MAX }),
      timeoutMs: EXEC_TIMEOUT_MS,
      maxOutputBytes: 2 * 1024 * 1024,
    },
    signal,
  )
  if (result.code !== 0)
    throw new Error(`instruction files: ${result.stderr.trim() || `exit ${result.code}`}`)
  return parseFiles(result.stdout)
}
