import { posix } from 'node:path'

import type { RepoInstructionFile } from '../environment'

/** Most of one instruction file that enters the context (the same default as Codex's `project_doc_max_bytes`). */
export const REPO_INSTRUCTIONS_FILE_MAX = 32 * 1024
/** Most instruction text one injection adds; files past it enter only as a pointer to the file. */
export const REPO_INSTRUCTIONS_TOTAL_MAX = 64 * 1024

const TAG = 'repository_instructions'
const OPEN = new RegExp(`<${TAG} path="([^"]*)" bytes="(\\d+)"( truncated="true")?( omitted="true")?>`, 'g')

const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`
const attr = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
const unattr = (value: string) => value.replaceAll('&quot;', '"').replaceAll('&amp;', '&')

/** An instruction file as it is in a context, read back from its text. */
export interface LoadedInstructionFile {
  path: string
  bytes: number
  truncated: boolean
}

/**
 * One text per file, in order (repository root first). `budget`: bytes of content still allowed in this
 * injection; a file past it enters only as a pointer, so the model reads it when it works there.
 */
export function repoInstructionTexts(
  files: readonly RepoInstructionFile[],
  budget = REPO_INSTRUCTIONS_TOTAL_MAX,
): string[] {
  let left = budget
  return files.map((file) => {
    const folder = posix.dirname(file.path)
    const name = posix.basename(file.path)
    const size = Buffer.byteLength(file.content)
    if (size > left) {
      return (
        `<${TAG} path="${attr(file.path)}" bytes="${file.bytes}" omitted="true">\n` +
        `The repository has instructions for ${folder} and the folders below it in ${file.path} (${kb(file.bytes)}), ` +
        `too long to include here with the others: read that file before working in that folder.\n</${TAG}>`
      )
    }
    left -= size
    const cut = file.truncated
      ? `\n[cut: the file has ${kb(file.bytes)}, the first ${kb(size)} are above; read the rest of ${file.path} before relying on it]`
      : ''
    return (
      `<${TAG} path="${attr(file.path)}" bytes="${file.bytes}"${file.truncated ? ' truncated="true"' : ''}>\n` +
      `Instructions of the repository for ${folder} and the folders below it, from its ${name}. Follow them while you work there.\n\n` +
      `${file.content.trim()}${cut}\n</${TAG}>`
    )
  })
}

/** Whether a text is one instruction file made by `repoInstructionTexts` (kept whole by the tool output cut). */
export function isRepoInstructionText(text: string): boolean {
  return text.startsWith(`<${TAG} path="`)
}

/** The instruction files a text already carries (a context's system, tool results, a CLI appendix). */
export function loadedInstructionFiles(text: string): LoadedInstructionFile[] {
  if (!text.includes(`<${TAG} `)) return []
  return [...text.matchAll(OPEN)].map((m) => ({
    path: unattr(m[1] ?? ''),
    bytes: Number(m[2]),
    truncated: !!m[3] || !!m[4],
  }))
}
