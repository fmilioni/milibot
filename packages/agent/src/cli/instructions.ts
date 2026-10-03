import { posix } from 'node:path'

import type { RepoInstructionFile } from '../environment'

/**
 * Splits the instruction files of a CLI's working folder chain into those the CLI reads by itself (`names`,
 * `CLI_ENGINE_INFO.instructionFiles`: the first one found in each folder) and the folders it would miss, whose
 * files Milibot adds. A file left out as the same text of another name counts under both names.
 */
export function splitEngineInstructions(
  names: readonly string[],
  files: readonly RepoInstructionFile[],
): { engine: RepoInstructionFile[]; missing: RepoInstructionFile[] } {
  const folders = new Map<string, RepoInstructionFile[]>()
  for (const file of files) {
    const folder = posix.dirname(file.path)
    folders.set(folder, [...(folders.get(folder) ?? []), file])
  }
  const engine: RepoInstructionFile[] = []
  const missing: RepoInstructionFile[] = []
  for (const group of folders.values()) {
    const read = names
      .map((name) => group.find((f) => [f.path, ...f.sameAs].some((p) => posix.basename(p) === name)))
      .find((f) => f !== undefined)
    if (read) engine.push(read)
    else missing.push(...group)
  }
  return { engine, missing }
}
