import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { Skill, SkillDetail, SkillImportCommitResult, SkillImportScan } from '@milibot/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import type { RuntimeHarness } from '../../../support/runtime-harness'
import { importRuntime, makeZip, skillMd, write } from './support'

let h: RuntimeHarness
let dir: string
let firstBotId: string

const runtimes = importRuntime()
beforeEach(() => {
  dir = runtimes.dir()
})

async function start(overrides: { githubApi?: string } = {}) {
  h = await runtimes.start(overrides)
  firstBotId = h.botId
}

const call: RuntimeHarness['call'] = (...args) => h.call(...args)

describe('importing skills from local folders and zips', () => {
  it('imports a folder, finds every skill in a parent folder and updates the one imported before', async () => {
    await start()
    const src = join(dir, 'src')
    write(join(src, 'pdf', 'SKILL.md'), skillMd('pdf'))
    write(join(src, 'pdf', 'scripts', 'fill.py'), 'print(1)\n')
    write(join(src, 'pdf', 'node_modules', 'x', 'index.js'), 'junk')
    write(join(src, 'docx', 'SKILL.md'), skillMd('docx'))

    const one = await call<SkillImportScan>(
      'scanSkillImport',
      {},
      { source: { kind: 'paths', paths: [join(src, 'pdf')] } },
    )
    expect(one.candidates).toEqual([
      expect.objectContaining({
        path: join(src, 'pdf'),
        name: 'pdf',
        files: 2,
        hasScripts: true,
        conflict: 'none',
        importAs: 'pdf',
        error: null,
      }),
    ])
    const committed = await call<SkillImportCommitResult>(
      'commitSkillImport',
      {},
      { scanId: one.scanId, paths: [join(src, 'pdf')], allowedBots: [firstBotId] },
    )
    expect(committed.failed).toEqual([])
    expect(committed.imported[0]).toMatchObject({
      slug: 'pdf',
      source: 'import',
      allowedBots: [firstBotId],
      fileCount: 2,
    })
    expect(committed.imported[0]?.origin).toMatchObject({ kind: 'path' })
    expect(readFileSync(join(dir, 'skills', 'pdf', 'scripts', 'fill.py'), 'utf8')).toBe('print(1)\n')
    expect(existsSync(join(dir, 'skills', 'pdf', 'node_modules'))).toBe(false)

    const both = await call<SkillImportScan>(
      'scanSkillImport',
      {},
      { source: { kind: 'paths', paths: [src] } },
    )
    expect(both.origin).toMatchObject({ kind: 'paths', label: 'src' })
    expect(both.candidates.map((c) => [c.name, c.conflict])).toEqual([
      ['docx', 'none'],
      ['pdf', 'name_taken'],
    ])

    write(join(src, 'pdf', 'SKILL.md'), skillMd('pdf', 'New description. Load it for PDFs.'))
    const again = await call<SkillImportScan>(
      'scanSkillImport',
      {},
      { source: { kind: 'paths', paths: [join(src, 'pdf')] } },
    )
    expect(again.candidates[0]).toMatchObject({
      conflict: 'update',
      importAs: 'pdf',
      existingSkillId: committed.imported[0]?.id,
    })
    const updated = await call<SkillImportCommitResult>(
      'commitSkillImport',
      {},
      { scanId: again.scanId, paths: [join(src, 'pdf')], allowedBots: 'all' },
    )
    expect(updated.imported[0]).toMatchObject({
      id: committed.imported[0]?.id,
      description: 'New description. Load it for PDFs.',
    })
  })

  it('imports only the file when given a lone SKILL.md, naming it after its folder when it has no name', async () => {
    await start()
    // Portuguese on purpose: the folder name is folded into an ASCII slug.
    const file = join(dir, 'src', 'Relatório Mensal', 'SKILL.md')
    write(file, '---\ndescription: Monthly report. Load it on the 1st.\n---\nSteps.\n')
    write(join(dir, 'src', 'Relatório Mensal', 'other.txt'), 'not taken')
    const scan = await call<SkillImportScan>(
      'scanSkillImport',
      {},
      { source: { kind: 'paths', paths: [file] } },
    )
    expect(scan.candidates[0]).toMatchObject({ name: 'relatorio-mensal', files: 1, error: null })
    const result = await call<SkillImportCommitResult>(
      'commitSkillImport',
      {},
      { scanId: scan.scanId, paths: [file] },
    )
    expect(result.imported[0]).toMatchObject({ slug: 'relatorio-mensal', fileCount: 1, error: null })
    expect(readFileSync(join(dir, 'skills', 'relatorio-mensal', 'SKILL.md'), 'utf8')).toContain(
      'name: relatorio-mensal',
    )

    await expect(
      call('scanSkillImport', {}, { source: { kind: 'paths', paths: [join(dir, 'nowhere')] } }),
    ).rejects.toMatchObject({ code: 'not_found', details: { reason: 'path_not_found' } })
    write(join(dir, 'empty', 'README.md'), 'hi')
    await expect(
      call('scanSkillImport', {}, { source: { kind: 'paths', paths: [join(dir, 'empty')] } }),
    ).rejects.toMatchObject({ details: { reason: 'no_skills_found' } })
  })

  it('reads nested skills from a zip, never writes unsafe entries and renames clashing names', async () => {
    await start()
    await call('createSkill', {}, { name: 'beta', description: 'Mine. Load it for beta.', body: 'x' })
    const zip = join(dir, 'bundle.zip')
    await makeZip(zip, {
      'bundle/alpha/SKILL.md': skillMd('alpha'),
      'bundle/alpha/run.sh': '#!/bin/sh\necho alpha\n',
      'bundle/alpha/../../../escape.txt': 'evil',
      '../evil.txt': 'evil',
      '/abs.txt': 'evil',
      'bundle/beta/SKILL.md': skillMd('beta'),
      'bundle/beta/nested/SKILL.md': skillMd('inner'),
      'bundle/web/SKILL.md': skillMd('web-browsing'),
      'bundle/node_modules/pkg/SKILL.md': skillMd('pkg'),
    })
    const scan = await call<SkillImportScan>(
      'scanSkillImport',
      {},
      { source: { kind: 'paths', paths: [zip] } },
    )
    expect(scan.candidates.map((c) => [c.path, c.name, c.conflict, c.importAs])).toEqual([
      [`${zip}#bundle/alpha`, 'alpha', 'none', 'alpha'],
      [`${zip}#bundle/beta`, 'beta', 'name_taken', 'beta-2'],
      [`${zip}#bundle/web`, 'web-browsing', 'similar_builtin', 'web-browsing-2'],
    ])
    expect(scan.candidates[0]).toMatchObject({ files: 2, hasScripts: true })
    expect(scan.candidates[1]).toMatchObject({ files: 2 })

    const result = await call<SkillImportCommitResult>(
      'commitSkillImport',
      {},
      { scanId: scan.scanId, paths: scan.candidates.map((c) => c.path) },
    )
    expect(result.failed).toEqual([])
    expect(result.imported.map((s) => s.slug)).toEqual(['alpha', 'beta-2', 'web-browsing-2'])
    const alpha = await call<SkillDetail>('getSkill', { skillId: result.imported[0]?.id as string })
    expect(alpha.files.map((f) => [f.path, f.executable])).toEqual([
      ['SKILL.md', false],
      ['run.sh', true],
    ])
    expect(readFileSync(join(dir, 'skills', 'beta-2', 'SKILL.md'), 'utf8')).toContain('name: beta-2')
    expect(existsSync(join(dir, 'skills', 'beta-2', 'nested', 'SKILL.md'))).toBe(true)
    for (const name of ['escape.txt', 'evil.txt', 'abs.txt']) {
      expect(existsSync(join(dir, name))).toBe(false)
      expect(existsSync(join(dir, 'skills', name))).toBe(false)
      expect(existsSync(join(dirname(dir), name))).toBe(false)
    }
    expect((await call<Skill[]>('listSkills')).find((s) => s.slug === 'web-browsing-2')?.error).toBeNull()

    await expect(call('commitSkillImport', {}, { scanId: 'nope', paths: ['x'] })).rejects.toMatchObject({
      details: { reason: 'scan_expired' },
    })
  })

  it("copies skills from another workspace's folder", async () => {
    await start()
    const other = `ws_other${Date.now()}`
    const otherDir = join(dirname(dir), other)
    try {
      write(join(otherDir, 'skills', 'brand-guide', 'SKILL.md'), skillMd('brand-guide'))
      write(join(otherDir, 'skills', 'brand-guide', 'logo.svg'), '<svg/>')
      write(join(otherDir, 'skills', '.imports', 'x', 'SKILL.md'), skillMd('hidden'))
      const scan = await call<SkillImportScan>(
        'scanSkillImport',
        {},
        { source: { kind: 'workspace', workspaceId: other } },
      )
      expect(scan.candidates.map((c) => [c.path, c.files])).toEqual([['brand-guide', 2]])
      const result = await call<SkillImportCommitResult>(
        'commitSkillImport',
        {},
        { scanId: scan.scanId, paths: ['brand-guide'] },
      )
      expect(result.imported[0]?.origin).toMatchObject({
        kind: 'workspace',
        workspaceId: other,
        path: 'brand-guide',
      })
      await expect(
        call('scanSkillImport', {}, { source: { kind: 'workspace', workspaceId: 'ws_missing' } }),
      ).rejects.toMatchObject({ details: { reason: 'workspace_not_found' } })
    } finally {
      rmSync(otherDir, { recursive: true, force: true })
    }
  })
})
