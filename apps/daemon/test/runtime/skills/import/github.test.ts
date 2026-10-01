import { parseGithubSkillUrl } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

describe('GitHub skill addresses', () => {
  it('reads GitHub addresses', () => {
    expect(parseGithubSkillUrl('anthropics/skills')).toEqual({
      owner: 'anthropics',
      repo: 'skills',
      ref: null,
      path: null,
    })
    expect(parseGithubSkillUrl('https://github.com/anthropics/skills.git')).toMatchObject({ repo: 'skills' })
    expect(parseGithubSkillUrl('git@github.com:acme/tools.git')).toMatchObject({
      owner: 'acme',
      repo: 'tools',
    })
    expect(parseGithubSkillUrl('github.com/acme/tools/tree/main/skills/pdf?x=1')).toEqual({
      owner: 'acme',
      repo: 'tools',
      ref: 'main',
      path: 'skills/pdf',
    })
    expect(parseGithubSkillUrl('https://github.com/acme/tools/blob/v2/skills/pdf/SKILL.md')).toEqual({
      owner: 'acme',
      repo: 'tools',
      ref: 'v2',
      path: 'skills/pdf',
    })
    expect(parseGithubSkillUrl('https://github.com/acme/tools/blob/main/SKILL.md')?.path).toBeNull()
    for (const bad of [
      '',
      'acme',
      'https://gitlab.com/a/b',
      'acme/tools/issues/1',
      'acme/to ols',
      'a/b/tree/main/../x',
    ])
      expect(parseGithubSkillUrl(bad)).toBeNull()
  })
})
