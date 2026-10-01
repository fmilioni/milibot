import { SKILL_LIMITS } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import {
  parseSkillMd,
  renderBuiltinBody,
  renderSkillMd,
  safeSkillPath,
  slugifySkillName,
  withSkillName,
} from './format'

const md = (frontmatter: string, body = '# Title\nDo it.') => `---\n${frontmatter}\n---\n${body}`

describe('SKILL.md', () => {
  it('reads name, description, optional fields and the body', () => {
    const parsed = parseSkillMd(
      md(
        'name: monthly-close\ndescription: >\n  Close the month.\n  Load it on the 1st.\nlicense: MIT\nmetadata:\n  author: ana',
      ),
    )
    expect(parsed).toEqual({
      ok: true,
      meta: {
        name: 'monthly-close',
        description: 'Close the month. Load it on the 1st.',
        license: 'MIT',
        metadata: { author: 'ana' },
        milibot: null,
      },
      body: '# Title\nDo it.',
    })
  })

  it('refuses what bots could not use', () => {
    const error = (text: string) => {
      const parsed = parseSkillMd(text)
      return parsed.ok ? null : parsed.error
    }
    expect(error('# no frontmatter')).toMatch(/frontmatter/)
    expect(error(md('name: Bad Name\ndescription: x'))).toMatch(/^name:/)
    expect(error(md(`name: ${'a'.repeat(65)}\ndescription: x`))).toMatch(/64/)
    expect(error(md('name: ok'))).toMatch(/description is required/)
    expect(error(md(`name: ok\ndescription: ${'d'.repeat(1025)}`))).toMatch(/1024/)
    expect(error(md('name: ok\ndescription: [unclosed'))).toMatch(/YAML/)
    expect(error(md('name: ok\ndescription: x', 'x'.repeat(SKILL_LIMITS.skillMdBytes)))).toMatch(/KB/)
    expect(error(md('name: ok\ndescription: x\nmilibot:\n  tools: [teleport]'))).toMatch(/tool families/)
    expect(error(md('name: ok\ndescription: x\nmilibot:\n  default: nobody'))).toMatch(/default/)
  })

  it('writes a SKILL.md that reads back the same', () => {
    const text = renderSkillMd({ name: 'x-y', description: 'Quotes " and: colons' }, '\nBody\n')
    expect(parseSkillMd(text)).toMatchObject({
      ok: true,
      meta: { name: 'x-y', description: 'Quotes " and: colons' },
      body: 'Body\n',
    })
  })

  it('renders built-in bodies for the bot', () => {
    const body =
      'cd {{bot_slug}}\n{{#claude_code}}CC only{{/claude_code}}{{^claude_code}}API only{{/claude_code}}'
    expect(renderBuiltinBody(body, { botSlug: 'ana', engine: 'claude_code' })).toBe('cd ana\nCC only')
    expect(renderBuiltinBody(body, { botSlug: 'ana', engine: null })).toBe('cd ana\nAPI only')
    expect(renderBuiltinBody('{{secret:TOKEN}}', { botSlug: 'a', engine: null })).toBe('{{secret:TOKEN}}')
  })

  it('keeps file paths inside the skill', () => {
    expect(safeSkillPath('./scripts//run.py')).toBe('scripts/run.py')
    for (const bad of ['../x', 'a/../../b', '/etc/passwd', 'a\\b', '', '.', 'C:x', 'notes.md:stream'])
      expect(safeSkillPath(bad)).toBeNull()
    expect(slugifySkillName('Export the résumé as PDF!')).toBe('export-the-resume-as-pdf')
    expect(slugifySkillName('---')).toBe('skill')
  })

  it('renames a SKILL.md keeping its other fields', () => {
    const renamed = withSkillName(
      md('name: Old Name\ndescription: Keep me.\nlicense: MIT\nmilibot:\n  tools: [browser]'),
      'new-name',
    )
    expect(parseSkillMd(renamed as string)).toMatchObject({
      ok: true,
      meta: { name: 'new-name', description: 'Keep me.', license: 'MIT', milibot: null },
      body: '# Title\nDo it.',
    })
    expect(withSkillName('no frontmatter', 'x')).toBeNull()
  })
})
