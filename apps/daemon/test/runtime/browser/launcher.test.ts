import { execFileSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { ENSURE_BROWSER_SCRIPT, parseEnsureOutput } from '../../../src/runtime/browser/launcher'

describe('Chrome ensure script', () => {
  it('is valid bash and its result is read', () => {
    execFileSync('bash', ['-n'], { input: ENSURE_BROWSER_SCRIPT })
    expect(parseEnsureOutput('RESTARTED=1\nSTATE=started\n')).toEqual({ state: 'started', restarted: true })
    expect(parseEnsureOutput('').state).toBe('unknown')
  })
})
