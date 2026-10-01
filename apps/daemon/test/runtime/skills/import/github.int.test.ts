import { readdirSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

import type { Skill, SkillImportCommitResult, SkillImportScan, SkillSourceCheck } from '@milibot/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { RuntimeHarness } from '../../../support/runtime-harness'
import { importRuntime, makeZip, skillMd } from './support'

let h: RuntimeHarness
let dir: string

const runtimes = importRuntime()
beforeEach(() => {
  dir = runtimes.dir()
})

async function start(overrides: { githubApi?: string } = {}) {
  h = await runtimes.start(overrides)
}

const call: RuntimeHarness['call'] = (...args) => h.call(...args)

let server: Server | null = null
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
})
describe('importing skills from GitHub', () => {
  it('scans a repo folder from its zipball, imports a skill and takes a newer version', async () => {
    const sha1 = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0'
    const sha2 = 'b1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0'
    let head = sha1
    let pathHead = 'p1'
    const zips: Record<string, string> = {}
    const requests: string[] = []
    const authorizations: Array<string | undefined> = []
    const buildZip = async (sha: string, version: string) => {
      const path = join(dir, `${sha}.zip`)
      const root = `acme-skills-${sha.slice(0, 7)}`
      await makeZip(path, {
        [`${root}/README.md`]: 'readme',
        [`${root}/skills/pdf/SKILL.md`]: skillMd('pdf', `PDF tools ${version}. Load it for PDFs.`),
        [`${root}/skills/pdf/scripts/fill.py`]: `print("${version}")\n`,
        [`${root}/skills/docx/SKILL.md`]: skillMd('docx'),
        [`${root}/skills/vendor/lib/SKILL.md`]: skillMd('lib'),
        [`${root}/other/x/SKILL.md`]: skillMd('outside'),
      })
      zips[sha] = path
    }
    await buildZip(sha1, 'v1')
    await buildZip(sha2, 'v2')
    const json = (res: ServerResponse, status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://x')
      requests.push(`${req.method} ${url.pathname}${url.search}`)
      authorizations.push(req.headers.authorization)
      if (url.pathname === '/repos/acme/skills')
        return json(res, 200, { full_name: 'acme/skills', default_branch: 'main' })
      if (url.pathname === '/repos/acme/private') {
        if (req.headers.authorization !== 'Bearer ghp_secret') return json(res, 404, { message: 'Not Found' })
        return json(res, 200, { full_name: 'acme/private', default_branch: 'main' })
      }
      if (url.pathname === '/repos/acme/skills/commits/main') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        return res.end(head)
      }
      if (url.pathname === '/repos/acme/skills/commits') {
        const at = url.searchParams.get('sha')
        const sha = at === sha1 ? 'p1' : pathHead
        return json(res, 200, [{ sha, commit: { committer: { date: '2026-09-20T10:00:00Z' } } }])
      }
      const zipball = /^\/repos\/acme\/skills\/zipball\/([0-9a-f]+)$/.exec(url.pathname)
      if (zipball) {
        res.writeHead(302, { location: `/codeload/${zipball[1]}` })
        return res.end()
      }
      const codeload = /^\/codeload\/([0-9a-f]+)$/.exec(url.pathname)
      if (codeload && zips[codeload[1] as string]) {
        res.writeHead(200, { 'content-type': 'application/zip' })
        return res.end(readFileSync(zips[codeload[1] as string] as string))
      }
      json(res, 404, { message: 'Not Found' })
    })
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
    const githubApi = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    await start({ githubApi })

    const scan = await call<SkillImportScan>(
      'scanSkillImport',
      {},
      { source: { kind: 'github', url: 'https://github.com/acme/skills/tree/main/skills' } },
    )
    expect(scan.origin).toEqual({ kind: 'github', label: 'acme/skills', ref: 'main', sha: sha1 })
    expect(scan.candidates.map((c) => c.path)).toEqual(['skills/docx', 'skills/pdf'])
    expect(readdirSync(join(dir, 'skills', '.imports'))).toEqual([`${scan.scanId}.zip`])
    const result = await call<SkillImportCommitResult>(
      'commitSkillImport',
      {},
      { scanId: scan.scanId, paths: ['skills/pdf'] },
    )
    const pdf = result.imported[0] as Skill
    expect(pdf.origin).toMatchObject({
      kind: 'github',
      repo: 'acme/skills',
      ref: 'main',
      sha: sha1,
      path: 'skills/pdf',
      pathSha: 'p1',
    })
    expect(pdf.updateAvailable).toBe(false)

    // A newer commit changed the folder: found by a check, taken by "Update from GitHub".
    head = sha2
    pathHead = 'p2'
    const check = await call<SkillSourceCheck>('updateSkillSource', { skillId: pdf.id }, { apply: false })
    expect(check).toMatchObject({ updateAvailable: true, latestSha: 'p2', updated: false })
    expect((await call<Skill[]>('listSkills')).find((s) => s.id === pdf.id)?.updateAvailable).toBe(true)
    const applied = await call<SkillSourceCheck>('updateSkillSource', { skillId: pdf.id }, { apply: true })
    expect(applied).toMatchObject({ updated: true, updateAvailable: false })
    expect(applied.skill).toMatchObject({
      id: pdf.id,
      description: 'PDF tools v2. Load it for PDFs.',
      updateAvailable: false,
    })
    expect(applied.skill.origin).toMatchObject({ sha: sha2, pathSha: 'p2' })
    expect(readFileSync(join(dir, 'skills', 'pdf', 'scripts', 'fill.py'), 'utf8')).toBe('print("v2")\n')
    expect(requests).toContain(`GET /codeload/${sha2}`)

    // A blob link to a SKILL.md looks only in its folder.
    const blob = await call<SkillImportScan>(
      'scanSkillImport',
      {},
      { source: { kind: 'github', url: 'acme/skills/blob/main/skills/docx/SKILL.md' } },
    )
    expect(blob.candidates.map((c) => c.path)).toEqual(['skills/docx'])

    await expect(
      call('scanSkillImport', {}, { source: { kind: 'github', url: 'acme/private' } }),
    ).rejects.toMatchObject({ code: 'not_found', details: { reason: 'github_not_found', hasToken: false } })
    await expect(
      call('scanSkillImport', {}, { source: { kind: 'github', url: 'https://example.com/x' } }),
    ).rejects.toMatchObject({ details: { reason: 'invalid_url' } })
    await runtimes.secrets().set(h.workspaceId, 'github.token', 'ghp_secret')
    await h.stop()
    await start({ githubApi })
    await expect(
      call('scanSkillImport', {}, { source: { kind: 'github', url: 'acme/private' } }),
    ).rejects.toMatchObject({ details: { reason: 'github_ref_not_found' } })
    expect(authorizations.at(-1)).toBe('Bearer ghp_secret')
  })
})
