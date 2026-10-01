import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

import { parseGoldenFileName, parseGoldenRevision } from '@milibot/shared'

/**
 * Revision of what `vm/provision.sh` installs, kept in `vm/golden-revision` and bumped whenever the
 * guest gains something workspaces need.
 */
export function expectedGoldenRevision(vmDir: string): number {
  try {
    return parseGoldenRevision(readFileSync(join(vmDir, 'golden-revision'), 'utf8'))
  } catch {
    return 1
  }
}

const revisions = new Map<string, number>()

/**
 * Revision of a golden image, from the manifest next to it (`debian13-golden-<ver>.json`). Versioned
 * images never change, so the answer is cached per resolved file.
 */
export function goldenRevision(goldenFile: string): number {
  let file: string
  try {
    file = realpathSync(goldenFile)
  } catch {
    return 1
  }
  const cached = revisions.get(file)
  if (cached !== undefined) return cached
  let revision = 1
  try {
    const manifest = JSON.parse(readFileSync(file.replace(/\.qcow2$/, '.json'), 'utf8')) as {
      revision?: unknown
    }
    const value = Number(manifest.revision)
    if (Number.isInteger(value) && value > 0) revision = value
  } catch {
    return 1
  }
  revisions.set(file, revision)
  return revision
}

export function goldenVersionOf(goldenFile: string): string | null {
  try {
    return parseGoldenFileName(realpathSync(goldenFile))?.version ?? null
  } catch {
    return null
  }
}
