import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { DefaultAgentHost } from '@milibot/agent'
import type { CompletionRequest } from '@milibot/agent/llm'
import type { FakeStep } from '@milibot/agent/testing'
import type { Bot, BotSkill, Skill, SkillDetail, ToolCallRow, WorkspaceEvent } from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import type { WorkspaceRuntime } from '../../../src/runtime/runtime'
import { MIRROR_APPLY_SCRIPT } from '../../../src/runtime/skills/scripts/mirror-apply.generated'
import { MIRROR_LIST_SCRIPT } from '../../../src/runtime/skills/scripts/mirror-list.generated'
import { type FakeGuest, fakeGuest } from '../../support/fake-guest'
import { bootRuntime, type RuntimeHarness, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'
import { until } from '../../support/wait'

let h: RuntimeHarness
let dir: string
let vmRoot: string
let runtime: WorkspaceRuntime
let host: DefaultAgentHost
let events: WorkspaceEvent[]
let chiefId: string
let chiefDm: string
let requests: CompletionRequest[]
let guest: FakeGuest

const tempDir = useTempDir('skills')
afterEach(stopRuntimes)

function execResult(result: { status: number | null; stdout: string; stderr: string }) {
  return {
    code: result.status,
    signal: null,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: {},
    timedOut: false,
    durationMs: 1,
  }
}

async function boot(turn: (request: CompletionRequest, i: number) => FakeStep = () => ({ text: 'ok' })) {
  dir = tempDir()
  vmRoot = join(dir, 'vm-skills')
  requests = []
  const skillsGuest = fakeGuest()
  // The mirror scripts run for real, on a temp folder standing for the VM's.
  skillsGuest.state.execResult = (body) => {
    const cmd = String(body.cmd ?? '')
    if (cmd === MIRROR_LIST_SCRIPT || cmd === MIRROR_APPLY_SCRIPT) {
      const env = { ...process.env, ...(body.env as Record<string, string>), MILIBOT_SKILLS_ROOT: vmRoot }
      return execResult(
        spawnSync('bash', ['-c', cmd], { input: String(body.stdin ?? ''), env, encoding: 'utf8' }),
      )
    }
    if (cmd.includes('-printf')) {
      return execResult({
        status: 0,
        stdout: '42\t644\tSKILL.md\n12\t755\tscripts/go.sh\n',
        stderr: '',
      })
    }
    return execResult({ status: 0, stdout: '', stderr: '' })
  }
  let turns = 0
  h = await bootRuntime({
    dir,
    guest: skillsGuest,
    script: (request) => {
      requests.push(request)
      if (request.tools.length === 0) return { text: 'Hello!' }
      return turn(request, turns++)
    },
  })
  ;({ runtime, host, events, guest, botId: chiefId, dm: chiefDm } = h)
  await host.idle()
  await runtime.services.skills.idle()
}

const call: RuntimeHarness['call'] = (...args) => h.call(...args)

const systemOf = (request: CompletionRequest | undefined) =>
  request?.messages[0]?.content.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? ''

function skillFolder(slug: string, description = 'Close the month. Load it on the 1st.') {
  const folder = join(dir, 'import-src', slug)
  mkdirSync(join(folder, 'scripts'), { recursive: true })
  writeFileSync(
    join(folder, 'SKILL.md'),
    `---\nname: ${slug}\ndescription: ${description}\n---\n# Steps\nRun it.\n`,
  )
  writeFileSync(join(folder, 'scripts', 'close.py'), 'print("ok")\n')
  return folder
}

describe('skills library', () => {
  it('lists the built-ins and picks up folders copied into skills/ by itself', async () => {
    await boot()
    const skills = await call<Skill[]>('listSkills')
    expect(skills.filter((s) => s.source === 'builtin').map((s) => s.id)).toContain('builtin:web-browsing')
    expect(skills.find((s) => s.id === 'builtin:team-management')).toMatchObject({
      defaultFor: 'first',
      tools: ['team'],
      editable: false,
      error: null,
    })

    cpSync(skillFolder('monthly-close'), join(dir, 'skills', 'monthly-close'), { recursive: true })
    await until(() =>
      events.some((e) => e.type === 'skill.updated' && e.payload.skill.slug === 'monthly-close'),
    )
    const copied = (await call<Skill[]>('listSkills')).find((s) => s.slug === 'monthly-close')
    expect(copied).toMatchObject({
      source: 'user',
      error: null,
      fileCount: 2,
      hasScripts: true,
      editable: true,
    })

    mkdirSync(join(dir, 'skills', 'Broken Skill'))
    writeFileSync(join(dir, 'skills', 'Broken Skill', 'SKILL.md'), 'no frontmatter')
    await until(() =>
      events.some((e) => e.type === 'skill.updated' && e.payload.skill.slug === 'Broken Skill'),
    )
    const broken = (await call<Skill[]>('listSkills')).find((s) => s.slug === 'Broken Skill')
    expect(broken?.error).toMatch(/Folder name/)

    // Mirrored in the VM with its files: root-owned read-only copy, scripts keep their mode.
    await runtime.services.skills.idle()
    await until(() => existsSync(join(vmRoot, 'monthly-close', 'scripts', 'close.py')))
    expect(readFileSync(join(vmRoot, 'monthly-close', '.milibot-hash'), 'utf8')).toHaveLength(32)
    expect(statSync(join(vmRoot, 'monthly-close', 'SKILL.md')).mode & 0o777).toBe(0o644)

    rmSync(join(dir, 'skills', 'monthly-close'), { recursive: true })
    await until(() => events.some((e) => e.type === 'skill.deleted' && e.payload.skillId === copied?.id))
    await until(() => !existsSync(join(vmRoot, 'monthly-close')))
    expect((await call<Skill[]>('listSkills')).some((s) => s.slug === 'monthly-close')).toBe(false)
  })

  it('creates, edits, duplicates and deletes skills through the routes', async () => {
    await boot()
    const created = await call<SkillDetail>(
      'createSkill',
      {},
      {
        name: 'invoice-check',
        description: 'Check invoices. Load it before paying one.',
        body: 'Check the tax ID.',
      },
    )
    expect(created).toMatchObject({ source: 'user', vmPath: null, files: [{ path: 'SKILL.md' }] })
    expect(created.skillMd).toContain('Check the tax ID.')
    await expect(
      call('createSkill', {}, { name: 'invoice-check', description: 'x', body: 'y' }),
    ).rejects.toMatchObject({ code: 'conflict' })

    const edited = await call<SkillDetail>(
      'putSkillContent',
      { skillId: created.id },
      { skillMd: '---\nname: invoice-check\ndescription: Updated.\n---\nNew body.\n' },
    )
    expect(edited).toMatchObject({ description: 'Updated.' })
    await expect(
      call(
        'putSkillContent',
        { skillId: created.id },
        { skillMd: '---\nname: other\ndescription: x\n---\n' },
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' })

    const copy = await call<SkillDetail>('duplicateSkill', { skillId: 'builtin:web-browsing' })
    expect(copy).toMatchObject({
      slug: 'web-browsing-copy',
      source: 'user',
      editable: true,
      tools: [],
      error: null,
    })
    expect(copy.skillMd).toContain('name: web-browsing-copy')
    expect(copy.skillMd).not.toContain('milibot')
    await expect(call('deleteSkill', { skillId: 'builtin:web-browsing' })).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'builtin' },
    })
    await call('deleteSkill', { skillId: copy.id })
    expect(existsSync(join(dir, 'skills', 'web-browsing-copy'))).toBe(false)
    expect(events.some((e) => e.type === 'skill.deleted' && e.payload.skillId === copy.id)).toBe(true)
  })
})

describe('skills and bots', () => {
  it('turns tool families and catalog entries on and off per workspace and per bot', async () => {
    await boot()
    const { bot: leo } = await call<{ bot: Bot }>(
      'createBot',
      {},
      { name: 'Leo', label: 'Dev', systemPrompt: 'You write code.' },
    )
    await host.idle()

    const leoSkills = await call<BotSkill[]>('listBotSkills', { botId: leo.id })
    expect(leoSkills.find((s) => s.skill.id === 'builtin:team-management')).toMatchObject({
      enabled: false,
      active: false,
    })
    const chief = runtime.store.bots.list().find((b) => b.id === chiefId) as Bot
    const leoBot = runtime.store.bots.list().find((b) => b.id === leo.id) as Bot
    expect(runtime.services.skills.skillContext(chief).families.has('team')).toBe(true)
    expect(runtime.services.skills.skillContext(leoBot).families.has('team')).toBe(false)

    const turnedOn = await call<BotSkill>(
      'updateBotSkill',
      { botId: leo.id, skillId: 'builtin:team-management' },
      { enabled: true },
    )
    expect(turnedOn.active).toBe(true)
    expect(runtime.services.skills.skillContext(leoBot).families.has('team')).toBe(true)

    await call('updateSkill', { skillId: 'builtin:web-browsing' }, { enabled: false })
    const context = runtime.services.skills.skillContext(chief)
    expect(context.families.has('browser')).toBe(false)
    expect(context.catalog).not.toContain('web-browsing')
    expect(context.catalog).toContain('- using-the-screen — ')

    await call('postMessage', { conversationId: chiefDm }, { content: 'hi' })
    await host.idle()
    const request = requests.at(-1)
    expect(systemOf(request)).toContain('# Skills')
    expect(systemOf(request)).not.toContain('web-browsing —')
    expect(request?.tools.map((t) => t.name)).not.toContain('browser_snapshot')
    expect(request?.tools.map((t) => t.name)).toContain('skill_load')

    // Claude Code sees the same set through the MCP server.
    const port = await runtime.services.mcp.listen()
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${runtime.services.mcp.tokenFor(chiefId, chiefId, 'claude_code')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_snapshot', arguments: {} } },
      ]),
    })
    const [init, list, refused] = (await response.json()) as Array<{ result: Record<string, unknown> }>
    expect(String(init?.result.instructions)).not.toContain('Chrome')
    expect(String(init?.result.instructions)).toContain('your own desktop')
    const names = (list?.result.tools as Array<{ name: string }>).map((t) => t.name)
    expect(names).not.toContain('browser_snapshot')
    expect(names).toContain('computer')
    expect(refused?.result.isError).toBe(true)
  })

  it('lets a bot save, load, read and delete its own skill, mirrored in the VM', async () => {
    await boot(
      (_request, i) =>
        [
          {
            toolCalls: [
              {
                name: 'skill_save',
                arguments: {
                  name: 'monthly-report',
                  description: 'Builds the monthly report. Load it before closing the month.',
                  body: '1. Run scripts/build.sh.\n2. Send the PDF.',
                  files: [{ path: 'scripts/build.sh', content: '#!/bin/sh\necho ok\n' }],
                },
              },
            ],
          },
          { toolCalls: [{ name: 'skill_load', arguments: { name: 'monthly-report' } }] },
          {
            toolCalls: [
              { name: 'skill_read', arguments: { name: 'monthly-report', path: 'scripts/build.sh' } },
            ],
          },
          {
            toolCalls: [
              { name: 'skill_read', arguments: { name: 'monthly-report', path: '../../etc/passwd' } },
            ],
          },
          { toolCalls: [{ name: 'skill_load', arguments: { name: 'code-and-repos' } }] },
          { text: 'Saved.' },
          { text: 'Recalled.' },
          { toolCalls: [{ name: 'skill_delete', arguments: { name: 'monthly-report' } }] },
          { text: 'Deleted.' },
        ][i] ?? { text: 'ok' },
    )
    await call('postMessage', { conversationId: chiefDm }, { content: 'keep this as a skill' })
    await host.idle()

    const tools = await call<ToolCallRow[]>('listToolCalls', { conversationId: chiefDm }, undefined, {
      limit: 20,
    })
    const [save, load, read, escape, builtin] = tools
    expect(save?.status).toBe('ok')
    expect(load?.status).toBe('ok')
    expect(JSON.stringify(load?.result)).toContain('Run scripts/build.sh')
    expect(JSON.stringify(load?.result)).toContain('/usr/local/share/milibot/skills/monthly-report/')
    expect(JSON.stringify(load?.result)).toContain('scripts/build.sh (')
    expect(JSON.stringify(read?.result)).toContain('echo ok')
    expect(escape?.status).toBe('error')
    expect(JSON.stringify(builtin?.result)).toContain('docker compose -p maestro')
    expect(JSON.stringify(builtin?.result)).toContain('## Workspace settings')

    const saved = (await call<Skill[]>('listSkills')).find((s) => s.slug === 'monthly-report')
    expect(saved).toMatchObject({ source: 'bot', authorBotId: chiefId, allowedBots: [chiefId], error: null })
    const card = runtime.store.messages
      .list(chiefDm, { limit: 50 })
      .messages.find((m) => m.payload?.type === 'skill_created')
    expect(card?.payload).toMatchObject({
      type: 'skill_created',
      skillId: saved?.id,
      botId: chiefId,
      name: 'monthly-report',
      scope: 'me',
      files: 2,
      updated: false,
    })
    expect(await call('getSkillUsage', { skillId: saved?.id as string })).toEqual({
      days: 30,
      loads: 1,
      bots: [{ botId: chiefId, count: 1 }],
    })
    expect(statSync(join(dir, 'skills', 'monthly-report', 'scripts', 'build.sh')).mode & 0o111).not.toBe(0)
    await runtime.services.skills.idle()
    await until(() => existsSync(join(vmRoot, 'monthly-report', 'scripts', 'build.sh')))
    expect(statSync(join(vmRoot, 'monthly-report', 'scripts', 'build.sh')).mode & 0o777).toBe(0o755)

    // Next turn: the catalog lists it for its author only.
    await call('postMessage', { conversationId: chiefDm }, { content: 'and now?' })
    await host.idle()
    expect(systemOf(requests.at(-1))).toContain('- monthly-report — Builds the monthly report.')
    const { bot: leo } = await call<{ bot: Bot }>(
      'createBot',
      {},
      { name: 'Leo', label: 'Dev', systemPrompt: '' },
    )
    const leoBot = runtime.store.bots.list().find((b) => b.id === leo.id) as Bot
    expect(runtime.services.skills.skillContext(leoBot).catalog).not.toContain('monthly-report')

    await call('postMessage', { conversationId: chiefDm }, { content: 'delete the skill' })
    await host.idle()
    expect(existsSync(join(dir, 'skills', 'monthly-report'))).toBe(false)
    await runtime.services.skills.idle()
    await until(() => !existsSync(join(vmRoot, 'monthly-report')))
  })

  it('saves a skill from a folder the bot prepared in /workspace, never over a skill that is not its own', async () => {
    await boot(
      (_request, i) =>
        [
          {
            toolCalls: [
              { name: 'skill_save', arguments: { name: 'web-browsing', description: 'x', body: 'y' } },
            ],
          },
          {
            toolCalls: [
              { name: 'skill_save', arguments: { name: 'deploy', from_path: '/workspace/deploy-skill' } },
            ],
          },
          { toolCalls: [{ name: 'skill_delete', arguments: { name: 'web-browsing' } }] },
          { text: 'ok' },
        ][i] ?? { text: 'ok' },
    )
    guest.state.files.set(
      '/workspace/deploy-skill/SKILL.md',
      '---\nname: deploy\ndescription: Deploys.\n---\nGo.\n',
    )
    guest.state.files.set('/workspace/deploy-skill/scripts/go.sh', '#!/bin/sh\nexit 0\n')
    await call('postMessage', { conversationId: chiefDm }, { content: 'save it' })
    await host.idle()
    const [taken, fromFolder, notOwn] = await call<ToolCallRow[]>(
      'listToolCalls',
      { conversationId: chiefDm },
      undefined,
      {
        limit: 20,
      },
    )
    expect(taken?.status).toBe('error')
    expect(JSON.stringify(taken?.result)).toContain('not one of yours')
    expect(fromFolder?.status).toBe('ok')
    expect(notOwn?.status).toBe('error')
    expect(JSON.stringify(notOwn?.result)).toContain('You can only delete the skills you created')
    expect(existsSync(join(dir, 'skills', 'deploy'))).toBe(true)
    expect(readFileSync(join(dir, 'skills', 'deploy', 'scripts', 'go.sh'), 'utf8')).toBe(
      '#!/bin/sh\nexit 0\n',
    )
    expect(statSync(join(dir, 'skills', 'deploy', 'scripts', 'go.sh')).mode & 0o111).not.toBe(0)
    const deploy = (await call<Skill[]>('listSkills')).find((s) => s.slug === 'deploy')
    expect(deploy).toMatchObject({ source: 'bot', description: 'Deploys.', error: null })
  })
})
