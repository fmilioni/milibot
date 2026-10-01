import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SECRET_FILES_SCRIPT } from '../../../src/runtime/credentials/scripts/secret-files.generated'

const mode = (path: string) => statSync(path).mode & 0o777

describe.skipIf(process.platform === 'win32')('secret files script', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  it('leaves the secrets root and its parent traversable so each bot reaches its own folder', () => {
    dir = mkdtempSync(join(tmpdir(), 'milibot-secret-files-'))
    const root = join(dir, 'milibot', 'secrets')
    const user = userInfo().username
    const value = Buffer.from('s3cret-value').toString('base64')
    execFileSync('bash', ['-c', SECRET_FILES_SCRIPT], {
      env: { ...process.env, MILIBOT_SECRETS_ROOT: root },
      input: `bot\tana\t${user}\t\t\nsecret\tana\t${user}\tAPI_KEY\t${value}\n`,
      windowsHide: true,
    })
    expect(mode(join(dir, 'milibot'))).toBe(0o711)
    expect(mode(root)).toBe(0o711)
    expect(mode(join(root, 'ana'))).toBe(0o700)
    expect(mode(join(root, 'ana', 'API_KEY'))).toBe(0o600)
    expect(readFileSync(join(root, 'ana', 'API_KEY'), 'utf8')).toBe('s3cret-value')
  })
})
