import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FOLDER_SCRIPT } from '../../../src/runtime/files/session-folder'
import { removeDir, tempDir } from '../../support/temp'

let root: string

beforeEach(() => {
  root = tempDir('session-folder')
  mkdirSync(join(root, 'workspace', 'app'), { recursive: true })
})
afterEach(() => removeDir(root))

function prepare(dir: string): string {
  const result = spawnSync('bash', ['-c', FOLDER_SCRIPT], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '', SESSION_DIR: dir, WORKSPACE_ROOT: join(root, 'workspace') },
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`exit ${result.status}: ${result.stderr}`)
  return result.stdout.trim()
}

describe('session folder script', () => {
  it('makes a missing folder and reports where it really is', () => {
    expect(prepare(join(root, 'workspace', 'calculator', 'web'))).toBe('REL=calculator/web')
    expect(existsSync(join(root, 'workspace', 'calculator', 'web'))).toBe(true)
    expect(prepare(join(root, 'workspace', 'app'))).toBe('REL=app')
  })

  it('reports a symlink that leads out of the workspace', () => {
    mkdirSync(join(root, 'elsewhere'))
    symlinkSync(join(root, 'elsewhere'), join(root, 'workspace', 'link'))
    expect(prepare(join(root, 'workspace', 'link'))).toBe('OUTSIDE=1')
    symlinkSync(join(root, 'workspace', '.milibot'), join(root, 'workspace', 'inner'))
    mkdirSync(join(root, 'workspace', '.milibot'), { recursive: true })
    expect(prepare(join(root, 'workspace', 'inner'))).toBe('REL=.milibot')
  })
})
