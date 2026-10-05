import { renderBuiltinBody } from '@milibot/agent'
import { SETTING_FAMILIES, TOOL_FAMILY_NAMES } from '@milibot/agent/tools'
import { SKILL_LIMITS } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { defaultBuiltinSkillsDir, SkillLibrary } from '../../../src/runtime/skills/library'

describe('built-in skills', () => {
  const dir = defaultBuiltinSkillsDir()
  const builtins = new SkillLibrary({ userDir: '/nonexistent', builtinDir: dir }).scan().builtins

  it('are all valid and declare known tool families', () => {
    expect(dir).toMatch(/packages\/agent\/skills$/)
    expect(builtins.map((b) => [b.slug, b.error])).toEqual(builtins.map((b) => [b.slug, null]))
    expect(builtins.map((b) => b.slug)).toEqual([
      'boards',
      'code-and-repos',
      'design',
      'design-to-code',
      'documents-pdf',
      'knowledge-base',
      'plans-and-sessions',
      'projects',
      'routines',
      'secrets-and-variables',
      'skill-creator',
      'slides',
      'team-management',
      'using-the-screen',
      'web-browsing',
      'workspace-settings',
    ])
    const families = builtins.flatMap((b) => b.meta?.milibot?.tools ?? [])
    expect([...new Set([...families, ...SETTING_FAMILIES])].sort()).toEqual([...TOOL_FAMILY_NAMES].sort())
    for (const b of builtins) {
      expect(b.meta?.description.length).toBeLessThanOrEqual(SKILL_LIMITS.descriptionLength)
      // Every active skill's description is in the catalog of each request: keep it short.
      expect(b.meta?.description.length).toBeLessThanOrEqual(160)
      expect(b.meta?.description).toMatch(/Load it/)
    }
    const defaults = Object.fromEntries(builtins.map((b) => [b.slug, b.meta?.milibot?.default ?? 'all']))
    expect(defaults['team-management']).toBe('first')
    expect(Object.values(defaults).filter((d) => d !== 'all')).toEqual(['first'])
    const slides = builtins.find((b) => b.slug === 'slides')
    expect(slides?.files.map((f) => [f.path, f.executable])).toContainEqual(['scripts/build_pptx.py', true])
  })

  it('tell each provider how screenshots stay in its context', () => {
    const screen = builtins.find((b) => b.slug === 'using-the-screen')?.body ?? ''
    const api = renderBuiltinBody(screen, { botSlug: 'iris', engine: null })
    const cc = renderBuiltinBody(screen, { botSlug: 'iris', engine: 'claude_code' })
    expect(api).toContain('Only the two most recent screenshots stay in your context')
    expect(cc).not.toContain('two most recent screenshots')
    expect(cc).toContain('Screenshots accumulate in your context for the whole session')
    const codex = renderBuiltinBody(screen, { botSlug: 'iris', engine: 'codex' })
    expect(codex).toContain('Screenshots accumulate in your context for the whole session')
    const web = builtins.find((b) => b.slug === 'web-browsing')?.body ?? ''
    expect(renderBuiltinBody(web, { botSlug: 'iris', engine: 'codex' })).toContain('web_fetch')
    expect(renderBuiltinBody(web, { botSlug: 'iris', engine: 'claude_code' })).toContain('WebFetch')
  })
})
