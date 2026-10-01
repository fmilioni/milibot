import { describe, expect, it } from 'vitest'

import { HttpError } from '../src/errors.ts'
import { clampTimeout, runCommand } from '../src/exec.ts'

const sh = (cmd: string) => ({
  file: 'bash',
  args: ['-c', cmd],
  env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
})
const opts = { cwd: '/', timeoutMs: 10_000, maxOutputBytes: 1024 }

describe('runCommand', () => {
  it('returns the exit code, both outputs and feeds stdin', async () => {
    const result = await runCommand(sh('cat; echo err >&2; exit 3'), { ...opts, stdin: 'hello\n' })
    expect(result).toMatchObject({
      code: 3,
      signal: null,
      stdout: 'hello\n',
      stderr: 'err\n',
      truncated: { stdout: false, stderr: false },
      timedOut: false,
    })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('runs in the given folder with only the given environment', async () => {
    const spec = { ...sh('pwd; echo "${HOME:-none}:$X"'), env: { ...sh('').env, X: 'y' } }
    expect((await runCommand(spec, { ...opts, cwd: '/tmp' })).stdout).toMatch(/^(\/private)?\/tmp\nnone:y\n$/)
  })

  it('caps each output and marks it truncated', async () => {
    const result = await runCommand(sh('head -c 5000 /dev/zero | tr "\\0" a'), {
      ...opts,
      maxOutputBytes: 100,
    })
    expect(result.stdout).toBe('a'.repeat(100))
    expect(result.truncated).toEqual({ stdout: true, stderr: false })
  })

  it('kills the whole process group on timeout', async () => {
    const result = await runCommand(sh('sleep 30 & sleep 30'), { ...opts, timeoutMs: 100 })
    expect(result.timedOut).toBe(true)
    expect(result.signal).toBe('SIGTERM')
  })

  it('rejects when the program cannot be started', async () => {
    await expect(runCommand({ file: '/nonexistent/bin', args: [], env: {} }, opts)).rejects.toThrow()
  })
})

describe('clampTimeout', () => {
  it('defaults, caps and refuses bad values', () => {
    expect(clampTimeout(undefined)).toBe(120_000)
    expect(clampTimeout(1500.4)).toBe(1500)
    expect(clampTimeout(10 * 3_600_000)).toBe(3_600_000)
    for (const bad of [0, -1, 'x', Number.NaN]) {
      expect(() => clampTimeout(bad)).toThrow(HttpError)
    }
  })
})
