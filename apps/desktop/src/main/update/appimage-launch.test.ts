import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { CLOSE_FDS_AND_EXEC } from './appimage-launch'

const run = (args: string[], extraFds = 0) =>
  spawnSync('bash', ['-c', CLOSE_FDS_AND_EXEC, 'bash', ...args], {
    // Descriptors 3 and up stand for the AppImage runtime's keep-alive pipe and Electron's own.
    stdio: ['ignore', 'pipe', 'pipe', ...Array<'pipe'>(extraFds).fill('pipe')],
    encoding: 'utf8',
  })

describe.runIf(process.platform === 'linux')('CLOSE_FDS_AND_EXEC', () => {
  it('runs the command without the descriptors the caller passed on, high ones included', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'fds-')), 'fds.txt')
    const result = run(['/bin/bash', '-c', `ls /proc/$$/fd > ${out}`], 12)
    expect(result.status).toBe(0)
    expect(readFileSync(out, 'utf8').split('\n').filter(Boolean).sort()).toEqual(['0', '1', '2'])
  })

  it('drops the output of the command it starts', () => {
    const result = run(['/bin/echo', 'a b', '--no-sandbox'], 3)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('reports a file it cannot start', () => {
    const result = run(['/nonexistent/Milibot.AppImage'])
    expect(result.status).toBe(1)
    expect(result.stderr).toBe('not executable: /nonexistent/Milibot.AppImage\n')
  })
})
