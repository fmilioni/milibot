import type { Bot, Skill, SkillImportCandidate } from '@milibot/shared'
import type { TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'

import {
  countByFilter,
  defaultSelection,
  fileTree,
  filterSkills,
  groupSkills,
  importablePaths,
  importErrorKey,
  isGithubAddress,
  needsGithubToken,
  originLines,
  shortPath,
  skillAccess,
  skillErrorKey,
  skillRowMeta,
  sourceChips,
  splitFrontmatter,
} from './skills'

function skill(patch: Partial<Skill> & Pick<Skill, 'slug'>): Skill {
  return {
    id: patch.slug,
    name: patch.slug,
    description: '',
    source: 'user',
    origin: null,
    authorBotId: null,
    enabled: true,
    allowedBots: 'all',
    defaultFor: 'all',
    tools: [],
    toolCount: 0,
    enabledFor: [],
    disabledFor: [],
    updateAvailable: false,
    error: null,
    editable: true,
    tokens: 10,
    fileCount: 1,
    bytes: 100,
    hasScripts: false,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  }
}

const bots = {
  bot_ana: { id: 'bot_ana', name: 'Ana' },
  bot_dex: { id: 'bot_dex', name: 'Dex' },
} as unknown as Record<string, Bot>

const library = [
  skill({ slug: 'web-browsing', source: 'builtin', description: 'Websites.' }),
  skill({ slug: 'team-management', source: 'builtin' }),
  skill({ slug: 'code-and-repos', source: 'builtin' }),
  skill({ slug: 'report', error: 'description is required.' }),
  skill({ slug: 'pdf', source: 'import', description: 'Extract tables from PDFs' }),
  skill({ slug: 'issue-invoice', name: 'Issue invoice', source: 'taught' }),
]

describe('skills screen', () => {
  it('counts, filters and searches ignoring accents and case', () => {
    expect(countByFilter(library)).toEqual({ all: 6, yours: 2, taught: 1, builtin: 3 })
    expect(filterSkills(library, 'yours', '').map((s) => s.slug)).toEqual(['report', 'pdf'])
    expect(filterSkills(library, 'all', 'TABLES pdf').map((s) => s.slug)).toEqual(['pdf'])
    expect(
      filterSkills(library, 'builtin', 'surf', (s) => ({
        name: s.slug === 'web-browsing' ? 'Surf the web' : s.name,
        description: s.description,
      })).map((s) => s.slug),
    ).toEqual(['web-browsing'])
  })

  it('groups yours, taught and included, invalid ones last and built-ins in their fixed order', () => {
    expect(groupSkills(library).map((g) => [g.group, g.skills.map((s) => s.slug)])).toEqual([
      ['yours', ['pdf', 'report']],
      ['taught', ['issue-invoice']],
      ['builtin', ['web-browsing', 'code-and-repos', 'team-management']],
    ])
    expect(groupSkills([skill({ slug: 'x', source: 'builtin' })]).map((g) => g.group)).toEqual(['builtin'])
  })

  it('shows where a skill came from and who may use it', () => {
    const github = skill({
      slug: 'pdf',
      source: 'import',
      origin: { kind: 'github', repo: 'anthropics/skills' },
      updateAvailable: true,
    })
    expect(sourceChips(github, bots)).toEqual([
      { kind: 'github', label: 'anthropics/skills' },
      { kind: 'update' },
    ])
    expect(sourceChips(skill({ slug: 'z', source: 'import', origin: { kind: 'zip' } }), bots)).toEqual([
      { kind: 'zip' },
    ])
    expect(sourceChips(skill({ slug: 'b', source: 'bot', authorBotId: 'bot_dex' }), bots)).toEqual([
      { kind: 'bot', name: 'Dex' },
    ])
    expect(sourceChips(skill({ slug: 'u' }), bots)).toEqual([{ kind: 'folder' }])
    expect(sourceChips(skill({ slug: 'w', source: 'builtin' }), bots)).toEqual([])
    expect(skillAccess({ allowedBots: 'all' }, bots)).toEqual({ kind: 'all' })
    expect(skillAccess({ allowedBots: ['bot_dex', 'bot_gone'] }, bots)).toEqual({ kind: 'only', name: 'Dex' })
    expect(skillAccess({ allowedBots: ['bot_ana', 'bot_dex'] }, bots)).toEqual({
      kind: 'some',
      names: ['Ana', 'Dex'],
    })
  })

  it('reads the frontmatter for the viewer', () => {
    expect(
      splitFrontmatter(
        '---\nname: pdf\ndescription: >\n  Use it for PDFs:\n  merge, split.\nlicense: "MIT"\n---\n\n# Guide\nText\n',
      ),
    ).toEqual({
      fields: [
        { key: 'name', value: 'pdf' },
        { key: 'description', value: 'Use it for PDFs: merge, split.' },
        { key: 'license', value: 'MIT' },
      ],
      body: '# Guide\nText\n',
    })
    expect(splitFrontmatter('# no frontmatter')).toEqual({ fields: [], body: '# no frontmatter' })
  })

  it('lists files as a tree, SKILL.md first', () => {
    const rows = fileTree([
      { path: 'scripts/b.py', bytes: 1, executable: true },
      { path: 'reference.md', bytes: 1, executable: false },
      { path: 'SKILL.md', bytes: 1, executable: false },
      { path: 'scripts/a.py', bytes: 1, executable: true },
      { path: 'LICENSE.txt', bytes: 1, executable: false },
    ])
    expect(rows.map((r) => `${'  '.repeat(r.depth)}${r.name}`)).toEqual([
      'SKILL.md',
      'LICENSE.txt',
      'reference.md',
      'scripts/',
      '  a.py',
      '  b.py',
    ])
  })

  it('names the error of the SKILL.md', () => {
    expect(skillErrorKey('description is required.')).toBe('skills.errors.noDescription')
    expect(skillErrorKey('something else')).toBeNull()
  })
})

describe('skill rows and detail', () => {
  const t = ((key: string, options?: Record<string, unknown>) =>
    options ? `${key} ${JSON.stringify(options)}` : key) as unknown as TFunction

  it('describes a built-in: tools, cost and who has a first-bot skill on', () => {
    const builtin = skill({ slug: 'team-management', source: 'builtin', toolCount: 4, tokens: 1200 })
    expect(skillRowMeta(builtin, bots, { first: true, t, locale: 'en' })).toEqual([
      { kind: 'tag', icon: 'tools', text: 'skills.meta.tools {"count":4}' },
      { kind: 'text', text: 'skills.meta.tokensOnLoad {"tokens":"1,200"}' },
    ])
    const firstOnly = skill({
      slug: 'team-management',
      source: 'builtin',
      hasScripts: true,
      defaultFor: 'first',
      enabledFor: ['bot_ana', 'bot_gone'],
    })
    expect(skillRowMeta(firstOnly, bots, { first: false, t, locale: 'en' })).toEqual([
      { kind: 'tag', icon: 'scripts', text: 'skills.meta.scripts' },
      { kind: 'text', text: 'skills.meta.tokens {"tokens":"10"}' },
      { kind: 'text', text: '·' },
      { kind: 'tag', icon: 'user', text: 'skills.access.activeFor {"names":"Ana"}' },
    ])
  })

  it('describes a skill of the workspace: access and files', () => {
    expect(
      skillRowMeta(skill({ slug: 'a', allowedBots: ['bot_dex'] }), bots, { first: false, t, locale: 'en' }),
    ).toEqual([
      { kind: 'tag', icon: 'user', text: 'skills.access.only {"name":"Dex"}' },
      { kind: 'text', text: 'skills.meta.files {"count":1}' },
    ])
    expect(
      skillRowMeta(skill({ slug: 'b', allowedBots: [] }), bots, { first: false, t, locale: 'en' }),
    ).toEqual([{ kind: 'text', text: 'skills.meta.files {"count":1} · skills.access.none' }])
    expect(
      skillRowMeta(skill({ slug: 'c', source: 'taught', fileCount: 0 }), bots, {
        first: false,
        t,
        locale: 'en',
      }),
    ).toEqual([{ kind: 'tag', icon: 'users', text: 'skills.access.allChip' }])
  })

  it('says where a skill came from', () => {
    const ctx = { bots, workspaces: [{ id: 'ws_1', name: 'Home' }], t, locale: 'en' }
    expect(originLines(skill({ slug: 'a', source: 'builtin' }), ctx)).toEqual([
      { text: 'skills.detail.origin.builtin' },
    ])
    const github = skill({
      slug: 'pdf',
      source: 'import',
      origin: {
        kind: 'github',
        repo: 'o/r',
        ref: 'main',
        path: 'skills/pdf',
        sha: 'abcdef123',
        importedAt: null,
      },
    })
    expect(originLines(github, ctx)).toEqual([
      { text: 'github.com/o/r' },
      { text: 'main · skills/pdf · abcdef1', mono: true },
      { text: 'skills.detail.origin.importedAt {"date":"…"}' },
    ])
    const zip = skill({
      slug: 'z',
      source: 'import',
      origin: { kind: 'zip', localPath: '/home/me/skills.zip', path: 'pdf' },
    })
    expect(originLines(zip, { ...ctx, platform: 'linux' })[0]).toEqual({
      text: '~/skills.zip › pdf',
      mono: true,
    })
    const fromWorkspace = skill({
      slug: 'w',
      source: 'import',
      origin: { kind: 'workspace', workspaceId: 'ws_1' },
    })
    expect(originLines(fromWorkspace, ctx)[0]).toEqual({
      text: 'skills.detail.origin.workspace {"name":"Home"}',
    })
  })
})

describe('importing', () => {
  it('reads GitHub addresses and paths', () => {
    expect(isGithubAddress('anthropics/skills')).toBe(true)
    expect(isGithubAddress('https://github.com/anthropics/skills/tree/main/skills/pdf')).toBe(true)
    expect(isGithubAddress('github.com/anthropics')).toBe(false)
    expect(
      importablePaths(['/a/folder', '/a/SKILL.md', '/a/x.zip', '/a/y.skill', '/a/photo.png', '']),
    ).toEqual(['/a/folder', '/a/SKILL.md', '/a/x.zip', '/a/y.skill'])
    expect(shortPath('/Users/ana/Downloads/skills.zip#bundle/pdf', 'mac')).toBe(
      '~/Downloads/skills.zip › bundle/pdf',
    )
    expect(shortPath('/Users/ana/x.zip#.', 'mac')).toBe('~/x.zip')
    expect(shortPath('/home/ana/x.zip#pdf', 'linux')).toBe('~/x.zip › pdf')
    expect(shortPath('C:\\Users\\ana\\skills', 'windows')).toBe('~\\skills')
    expect(shortPath('skills/pdf', 'mac')).toBe('skills/pdf')
  })

  it('checks importable candidates, leaving out clashes with included skills', () => {
    const candidate = (path: string, patch: Partial<SkillImportCandidate> = {}): SkillImportCandidate => ({
      path,
      name: path,
      description: '',
      files: 1,
      bytes: 1,
      hasScripts: false,
      conflict: 'none',
      importAs: path,
      existingSkillId: null,
      error: null,
      errorCode: null,
      errorParams: null,
      ...patch,
    })
    expect(
      defaultSelection([
        candidate('a'),
        candidate('b', { conflict: 'update' }),
        candidate('c', { conflict: 'similar_builtin' }),
        candidate('d', { error: 'bad' }),
        candidate('e', { conflict: 'name_taken' }),
      ]),
    ).toEqual(['a', 'b', 'e'])
  })

  it('explains import errors', () => {
    expect(importErrorKey({ reason: 'github_not_found', hasToken: false })).toBe(
      'skills.import.errors.notFoundNoToken',
    )
    expect(importErrorKey({ reason: 'github_not_found', hasToken: true })).toBe(
      'skills.import.errors.notFound',
    )
    expect(importErrorKey({ reason: 'no_skills_found' })).toBe('skills.import.errors.no_skills_found')
    expect(importErrorKey({ reason: 'weird' })).toBeNull()
    expect(needsGithubToken({ reason: 'github_not_found', hasToken: false })).toBe(true)
    expect(needsGithubToken({ reason: 'github_not_found', hasToken: true })).toBe(false)
  })
})
