import { describe, expect, it } from 'vitest'

import { discoverSkillDirs } from '../../../../src/runtime/skills/import/scan'

describe('discoverSkillDirs', () => {
  it('finds the outermost skill folders, skipping dependencies and build output', () => {
    const paths = [
      'README.md',
      'skills/pdf/SKILL.md',
      'skills/pdf/scripts/SKILL.md',
      'skills/docx/SKILL.md',
      'skills/node_modules/x/SKILL.md',
      'vendor/y/SKILL.md',
      'dist/z/SKILL.md',
      'other/SKILL.md',
    ]
    expect(discoverSkillDirs(paths)).toEqual(['other', 'skills/docx', 'skills/pdf'])
    expect(discoverSkillDirs(paths, 'skills/')).toEqual(['skills/docx', 'skills/pdf'])
    expect(discoverSkillDirs(['SKILL.md', 'a/SKILL.md'])).toEqual([''])
  })
})
