import { describe, expect, it } from 'vitest'

import { DaemonError } from '../../../src/errors'
import {
  assertFolderFree,
  checkPreparedFolder,
  sessionFolder,
} from '../../../src/runtime/files/session-folder'

function failure(run: () => unknown): DaemonError {
  try {
    run()
  } catch (err) {
    if (err instanceof DaemonError) return err
    throw err
  }
  throw new Error('expected a DaemonError')
}

describe('session folder', () => {
  it('normalizes a folder inside /workspace', () => {
    expect(sessionFolder('/workspace/calculator')).toBe('/workspace/calculator')
    expect(sessionFolder(' /workspace/apps//calculator/ ')).toBe('/workspace/apps/calculator')
    expect(sessionFolder('/workspace/a/../calculator')).toBe('/workspace/calculator')
    expect(sessionFolder('/workspace/sessions/chief-01abcdef')).toBe('/workspace/sessions/chief-01abcdef')
  })

  it('refuses folders outside /workspace or managed by Milibot, with a reason', () => {
    const cases: Array<[string, RegExp]> = [
      ['calculator', /not an absolute path/],
      ['~/calculator', /not an absolute path/],
      ['/workspace', /outside \/workspace/],
      ['/workspace/', /outside \/workspace/],
      ['/home/bot/app', /outside \/workspace/],
      ['/workspace/../etc', /\/etc is outside \/workspace/],
      ['/workspacex/app', /outside \/workspace/],
      ['/workspace/.milibot/sessions', /Milibot's own data/],
      ['/workspace/worktrees/app/chief-1', /repository worktrees/],
      ['/workspace/repos/app', /shared clones/],
      ['/workspace/sessions', /every work session/],
      ['/workspace/app\nx', /not valid/],
    ]
    for (const [value, reason] of cases) {
      const err = failure(() => sessionFolder(value))
      expect(err.code).toBe('validation_failed')
      expect(err.message).toMatch(/^Invalid folder: /)
      expect(err.message).toMatch(reason)
    }
  })

  it('refuses a folder overlapping the folder of another open session', () => {
    const open = [
      { cwd: '/workspace/sessions/chief-01abcdef', title: 'Notes' },
      { cwd: '/workspace', title: 'Fallback' },
      { cwd: null, title: 'Unknown' },
      { cwd: '/workspace/app', title: 'App' },
    ]
    expect(() => assertFolderFree('/workspace/other', open)).not.toThrow()
    expect(() => assertFolderFree('/workspace/application', open)).not.toThrow()
    for (const folder of ['/workspace/app', '/workspace/app/src', '/workspace/sessions/chief-01abcdef/x']) {
      const err = failure(() => assertFolderFree(folder, open))
      expect(err.code).toBe('conflict')
      expect(err.message).toContain('open work session')
    }
    expect(failure(() => assertFolderFree('/workspace/sessions', [open[0]!])).code).toBe('conflict')
  })

  it('checks where the folder really is once made in the VM', () => {
    expect(() => checkPreparedFolder('/workspace/app', 'REL=app\n')).not.toThrow()
    expect(() => checkPreparedFolder('/workspace/app', '')).not.toThrow()
    expect(() => checkPreparedFolder('/workspace/link', 'OUTSIDE=1\n')).toThrow(/leads outside/)
    expect(() => checkPreparedFolder('/workspace/link', 'REL=.milibot/sessions\n')).toThrow(/own data/)
  })
})
