import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach } from 'vitest'

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `milibot-${prefix}-`))
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

/** A fresh temp dir for each test, removed after the test's own `afterEach` hooks ran. */
export function useTempDir(prefix: string): () => string {
  let dir = ''
  beforeEach(() => {
    dir = tempDir(prefix)
  })
  afterEach(() => removeDir(dir))
  return () => dir
}
