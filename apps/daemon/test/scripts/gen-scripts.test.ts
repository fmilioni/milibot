import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { generatedScripts, orphanedModules, scriptConstant } from '../../scripts/gen-scripts'

describe('generated script modules', () => {
  it('are up to date with their scripts (pnpm gen:scripts)', () => {
    const stale = [...generatedScripts()].filter(
      ([path, text]) => !existsSync(path) || readFileSync(path, 'utf8') !== text,
    )
    expect(stale.map(([path]) => path)).toEqual([])
    expect(orphanedModules()).toEqual([])
  })

  it('names each constant after its file', () => {
    expect(scriptConstant('relay.js')).toBe('RELAY_SCRIPT')
    expect(scriptConstant('changes-script.sh')).toBe('CHANGES_SCRIPT')
    expect(scriptConstant('secret-files.sh')).toBe('SECRET_FILES_SCRIPT')
  })
})
