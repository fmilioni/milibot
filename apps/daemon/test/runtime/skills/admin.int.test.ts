import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

import type { CompletionRequest } from '@milibot/agent/llm'
import type { FakeStep } from '@milibot/agent/testing'
import type { BotMcpServer, BotSkill, McpServer, Message, Skill } from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { ZipWriter } from '../../../src/util/zip'
import { fakeGuest } from '../../support/fake-guest'
import { bootRuntime, type RuntimeHarness, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'
import { until } from '../../support/wait'
import { makeZip, skillMd } from './import/support'

let h: RuntimeHarness
let requests: CompletionRequest[]
let github: Server | null = null

const tempDir = useTempDir('skill-admin')
afterEach(async () => {
  await stopRuntimes()
  await new Promise<void>((resolve) => (github ? github.close(() => resolve()) : resolve()))
  github = null
})

const SHA = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0'

/** A local GitHub API serving `acme/skills`, whose zipball is read from `zip()` on every download. */
async function startGithub(zip: () => string): Promise<string> {
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  github = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/repos/acme/skills')
      return json(res, 200, { full_name: 'acme/skills', default_branch: 'main' })
    if (url.pathname === '/repos/acme/skills/commits/main') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      return res.end(SHA)
    }
    if (url.pathname === '/repos/acme/skills/commits') return json(res, 200, [{ sha: 'p1' }])
    if (url.pathname === `/repos/acme/skills/zipball/${SHA}`) {
      res.writeHead(200, { 'content-type': 'application/zip' })
      return res.end(readFileSync(zip()))
    }
    json(res, 404, { message: 'Not Found' })
  })
  await new Promise<void>((resolve) => github?.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(github.address() as AddressInfo).port}`
}

async function boot(script: FakeStep[], options: { githubApi?: string; dir?: string } = {}) {
  requests = []
  h = await bootRuntime({
    dir: options.dir ?? tempDir(),
    host: { compaction: false },
    guest: fakeGuest(),
    script: (request) => {
      if (request.tools.length === 0) return { text: 'Hi!' }
      requests.push(request)
      return script[requests.length - 1] ?? { text: 'Done.' }
    },
    ...(options.githubApi ? { overrides: { githubApi: options.githubApi } } : {}),
  })
}

const call: RuntimeHarness['call'] = (...args) => h.call(...args)

async function messages(): Promise<Message[]> {
  const page = await call<{ messages: Message[] }>('listMessages', { conversationId: h.dm }, undefined, {
    limit: 100,
  })
  return page.messages
}

type Card = Message & { payload: { confirmationId: string; status: string; params: Record<string, string> } }

async function pendingCard(action: string): Promise<Card> {
  let found: Message | undefined
  await until(async () => {
    found = (await messages()).find(
      (m) =>
        m.payload?.type === 'confirmation' && m.payload.action === action && m.payload.status === 'pending',
    )
    return found !== undefined
  }, 8000)
  return found as Card
}

const resolve = (card: Card, approved: boolean) =>
  call<Message>('resolveConfirmation', { confirmationId: card.payload.confirmationId }, { approved })

const cardStatus = async (card: Card) =>
  ((await messages()).find((m) => m.id === card.id)?.payload as { status: string }).status

/** The tool results the bot got, in order. */
const toolResults = (): string[] =>
  requests
    .map((r) => r.messages.at(-1))
    .filter((m) => m?.role === 'tool')
    .map((m) => JSON.stringify(m?.content))

const imported = async () => (await call<Skill[]>('listSkills')).filter((s) => s.source === 'import')

describe('skill_import', () => {
  it('installs only after the approval, and only what the card showed', async () => {
    const dir = tempDir()
    const zip = join(dir, 'repo.zip')
    const root = `acme-skills-${SHA.slice(0, 7)}`
    const build = (pdfBody: string) =>
      makeZip(zip, {
        [`${root}/skills/pdf/SKILL.md`]: `---\nname: pdf\ndescription: PDF tools. Load it for PDFs.\nmilibot:\n  tools: [team]\n---\n${pdfBody}\n`,
        [`${root}/skills/pdf/scripts/fill.py`]: 'print(1)\n',
        [`${root}/skills/docx/SKILL.md`]: skillMd('docx'),
      })
    await build('Fill forms.')
    const githubApi = await startGithub(() => zip)
    const importIt = (skills: string[]) => ({
      toolCalls: [
        {
          name: 'skill_import',
          arguments: { source: 'https://github.com/acme/skills/tree/main/skills', skills, reason: 'PDFs' },
        },
      ],
    })
    await boot([importIt(['pdf']), importIt(['docx']), importIt(['docx'])], { githubApi, dir })

    await call('postMessage', { conversationId: h.dm }, { content: 'import the pdf skill' })
    const first = await pendingCard('skill_import')
    expect(first.content).toContain('wants to import skills from acme/skills@a1b2c3d')
    expect(JSON.parse(first.payload.params.details as string)).toEqual({
      source: { kind: 'github', repo: 'acme/skills', ref: 'main', sha: SHA },
      skills: [
        expect.objectContaining({ name: 'pdf', importAs: 'pdf', hasScripts: true, declaredTools: ['team'] }),
      ],
      bots: 'all',
      families: [],
    })
    expect(await imported()).toEqual([])

    // Expired scan (or a restart): the same commit is downloaded again and still matches.
    h.runtime.services.skills.importer.stop()
    await resolve(first, true)
    const second = await pendingCard('skill_import')
    expect(toolResults()[0]).toMatch(/Imported pdf for every bot; they unlock no tool families/)
    const pdf = (await imported())[0] as Skill
    expect(pdf).toMatchObject({ slug: 'pdf', tools: [], allowedBots: 'all' })
    expect(pdf.origin).toMatchObject({ kind: 'github', repo: 'acme/skills', sha: SHA })

    // The archive behind the commit changed after the card was shown: nothing installed, card expired.
    h.runtime.services.skills.importer.stop()
    await makeZip(zip, {
      [`${root}/skills/docx/SKILL.md`]: skillMd('docx', 'Changed. Load it for docx.'),
    })
    await resolve(second, true)
    const third = await pendingCard('skill_import')
    expect(toolResults()[1]).toMatch(/source changed since the user saw the card, so nothing was installed/)
    expect(await cardStatus(second)).toBe('expired')
    expect((await imported()).map((s) => s.slug)).toEqual(['pdf'])

    await resolve(third, false)
    await h.host.idle()
    expect(toolResults()[2]).toMatch(
      /declined importing skills from acme\/skills@a1b2c3d\. Nothing was installed/,
    )
    expect((await imported()).map((s) => s.slug)).toEqual(['pdf'])
  })

  it('reads a zip under /workspace as the bot and refuses one that points outside it', async () => {
    const forMe: { source: string; bots: string[] } = { source: '/workspace/pack.zip', bots: [] }
    await boot([
      { toolCalls: [{ name: 'skill_import', arguments: { source: '/workspace/link.zip' } }] },
      { toolCalls: [{ name: 'skill_import', arguments: { source: '/etc/pack.zip' } }] },
      { toolCalls: [{ name: 'skill_import', arguments: forMe }] },
    ])
    forMe.bots = [h.botId]
    const dir = tempDir()
    await makeZip(join(dir, 'pack.zip'), { 'pack/SKILL.md': skillMd('pack') })
    const bytes = readFileSync(join(dir, 'pack.zip'))
    h.guest.state.files.set('/workspace/pack.zip', bytes)
    h.guest.state.execResult = (body) => {
      const src = String((body.env as Record<string, string> | undefined)?.SRC ?? '')
      const real = src === '/workspace/link.zip' ? '/root/secret.zip' : src
      return {
        code: 0,
        signal: null,
        stdout: `${real}\n${bytes.length}\n`,
        stderr: '',
        truncated: {},
        timedOut: false,
        durationMs: 1,
      }
    }
    await call('postMessage', { conversationId: h.dm }, { content: 'import my zip' })
    const card = await pendingCard('skill_import')
    expect(toolResults()[0]).toMatch(/points outside \/workspace/)
    expect(toolResults()[1]).toMatch(/must be a file under \/workspace/)
    expect(JSON.parse(card.payload.params.details as string)).toMatchObject({
      source: { kind: 'zip', path: '/workspace/pack.zip' },
      skills: [expect.objectContaining({ name: 'pack', declaredTools: [] })],
    })
    await resolve(card, true)
    await h.host.idle()
    const pack = (await imported())[0] as Skill
    expect(pack).toMatchObject({ slug: 'pack', allowedBots: [h.botId] })
    expect(pack.origin).toMatchObject({ kind: 'zip', vmPath: '/workspace/pack.zip', path: 'pack' })
  })

  it('drops the scan and its copy when the zip cannot be read in full', async () => {
    const dir = tempDir()
    await boot([{ toolCalls: [{ name: 'skill_import', arguments: { source: '/workspace/forged.zip' } }] }], {
      dir,
    })
    const path = join(tempDir(), 'forged.zip')
    const zip = await ZipWriter.create(path)
    await zip.addBuffer('pack/SKILL.md', Buffer.from(skillMd('pack')))
    await zip.addBuffer('pack/data.txt', Buffer.alloc(4 * 1024 * 1024, 'a'), { deflate: true })
    await zip.finish()
    // The central directory claims 10 bytes for data.txt, which inflates to 4 MB.
    const bytes = readFileSync(path)
    bytes.writeUInt32LE(10, bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24)
    h.guest.state.files.set('/workspace/forged.zip', bytes)
    h.guest.state.execResult = () => ({
      code: 0,
      signal: null,
      stdout: `/workspace/forged.zip\n${bytes.length}\n`,
      stderr: '',
      truncated: {},
      timedOut: false,
      durationMs: 1,
    })
    await call('postMessage', { conversationId: h.dm }, { content: 'import the forged zip' })
    await h.host.idle()
    expect(toolResults()[0]).toMatch(/too large/)
    expect((await messages()).some((m) => m.payload?.type === 'confirmation')).toBe(false)
    const imports = join(dir, 'skills', '.imports')
    expect(existsSync(imports) ? readdirSync(imports) : []).toEqual([])
  })
})

describe('bot_skills_set and bot_mcp_set', () => {
  const botSkill = async (slug: string) =>
    (await call<BotSkill[]>('listBotSkills', { botId: h.botId })).find(
      (s) => s.skill.slug === slug,
    ) as BotSkill

  it('changes the bot itself only after the approval and refuses a skill off in the workspace', async () => {
    await boot([
      { toolCalls: [{ name: 'bot_skills_set', arguments: { enable: ['boards'] } }] },
      { toolCalls: [{ name: 'bot_skills_set', arguments: { disable: ['routines'], reason: 'Not needed' } }] },
      { toolCalls: [{ name: 'bot_skills_set', arguments: { enable: ['routines'] } }] },
    ])
    const boards = await botSkill('boards')
    await call('updateSkill', { skillId: boards.skill.id }, { enabled: false })
    await call('postMessage', { conversationId: h.dm }, { content: 'drop the routines skill' })
    const card = await pendingCard('bot_skills')
    expect(toolResults()[0]).toMatch(/boards.{1,4} is turned off for the whole workspace/)
    expect(card.content).toContain('wants to change its own skills')
    const details = JSON.parse(card.payload.params.details as string) as { changes: unknown[] }
    expect(details.changes).toEqual([
      {
        skill: 'routines',
        on: false,
        families: ['routines'],
        tools: expect.any(Number) as number,
        allow: false,
      },
    ])
    const bot = h.store.bots.get(h.botId)
    expect(h.runtime.services.skills.skillContext(bot).families.has('routines')).toBe(true)

    await resolve(card, true)
    const again = await pendingCard('bot_skills')
    expect(toolResults()[1]).toMatch(/Skills of .*: routines off/)
    expect(h.runtime.services.skills.skillContext(bot).families.has('routines')).toBe(false)
    expect((await botSkill('routines')).enabled).toBe(false)

    await resolve(again, false)
    await h.host.idle()
    expect(toolResults()[2]).toMatch(/declined changing the skills/)
    expect((await botSkill('routines')).enabled).toBe(false)
  })

  it('refuses a bot that does not manage the team', async () => {
    await boot([{ toolCalls: [{ name: 'bot_skills_set', arguments: { disable: ['design'] } }] }])
    const team = await botSkill('team-management')
    await call('updateBotSkill', { botId: h.botId, skillId: team.skill.id }, { enabled: false })
    await call('postMessage', { conversationId: h.dm }, { content: 'drop design' })
    await h.host.idle()
    expect(toolResults()[0]).toMatch(/manages the team|turned off for you/)
    expect((await messages()).some((m) => m.payload?.type === 'confirmation')).toBe(false)
    expect((await botSkill('design')).enabled).toBe(true)
  })

  it('turns on an MCP server for the bot, giving it access, and tells the app', async () => {
    await boot([{ toolCalls: [{ name: 'bot_mcp_set', arguments: { enable: ['Tracker'] } }] }])
    const { bot: other } = await call<{ bot: { id: string } }>(
      'createBot',
      {},
      { name: 'Iris', label: 'Dev', systemPrompt: '' },
    )
    const server = await call<McpServer>(
      'createMcpServer',
      {},
      { name: 'Tracker', transport: 'http', url: 'http://127.0.0.1:1/mcp', allowedBots: [other.id] },
    )
    await call('postMessage', { conversationId: h.dm }, { content: 'give yourself the tracker' })
    const card = await pendingCard('bot_mcp')
    expect(JSON.parse(card.payload.params.details as string)).toEqual({
      changes: [{ server: 'Tracker', on: true, tools: [], allow: true }],
    })
    expect(await call<BotMcpServer[]>('listBotMcpServers', { botId: h.botId })).toEqual([])

    await resolve(card, true)
    await h.host.idle()
    expect(toolResults()[0]).toMatch(/MCP servers of .*: Tracker on/)
    expect((await call<McpServer[]>('listMcpServers'))[0]?.allowedBots).toEqual([other.id, h.botId])
    expect(await call<BotMcpServer[]>('listBotMcpServers', { botId: h.botId })).toEqual([
      { serverId: server.id, enabled: true, disabledTools: [] },
    ])
    expect(h.events).toContainEqual({
      type: 'mcp.bot_server.updated',
      payload: { botId: h.botId, server: { serverId: server.id, enabled: true, disabledTools: [] } },
    })
  })
})
