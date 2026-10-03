import { posix } from 'node:path'

import type { RepoInstructionFile, RepoInstructionsPort } from '../environment'
import { REPO_INSTRUCTIONS_FILE_MAX } from '../prompts/repo-instructions'

/**
 * `repoInstructions` over an in-memory tree, with the daemon's rules: `repos` are the repository roots,
 * `files` path → text (a value starting with `->` is a symlink to that path). Every call is recorded.
 */
export function fakeRepoInstructions(
  repos: string[],
  files: Record<string, string>,
  maxBytes = REPO_INSTRUCTIONS_FILE_MAX,
): RepoInstructionsPort['repoInstructions'] & { calls: string[][] } {
  const real = (path: string) => {
    const value = files[path]
    return value?.startsWith('->') ? value.slice(2) : path
  }
  const text = (path: string) => files[real(path)]
  const calls: string[][] = []
  const resolve = async (_bot: unknown, paths: string[]) => {
    calls.push(paths)
    const seen = new Set<string>()
    const out: RepoInstructionFile[] = []
    for (const path of paths) {
      const dir = files[path] !== undefined ? posix.dirname(path) : posix.normalize(path)
      const root = repos
        .filter((r) => dir === r || dir.startsWith(`${r}/`))
        .sort((a, b) => b.length - a.length)[0]
      if (!root) continue
      const rel = posix.relative(root, dir)
      const folders = [
        root,
        ...(rel ? rel.split('/').map((_, i, all) => posix.join(root, ...all.slice(0, i + 1))) : []),
      ]
      for (const folder of folders) {
        const found = ['CLAUDE.md', 'AGENTS.md']
          .map((name) => posix.join(folder, name))
          .filter((p) => text(p) !== undefined)
        const [first, second] = found
        const same =
          first && second && (real(first) === real(second) || text(first)?.trim() === text(second)?.trim())
        for (const file of same ? [first] : found) {
          if (!file || seen.has(file)) continue
          seen.add(file)
          const content = text(file) ?? ''
          const bytes = Buffer.byteLength(content)
          const truncated = bytes > maxBytes
          let kept = content
          if (truncated) {
            const head = Buffer.from(content).subarray(0, maxBytes)
            const end = head.lastIndexOf(10)
            kept = (end > 0 ? head.subarray(0, end + 1) : head).toString('utf8')
          }
          out.push({ path: file, bytes, truncated, content: kept })
        }
      }
    }
    return out
  }
  return Object.assign(resolve, { calls })
}
