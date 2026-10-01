import { CODEX_VERSION, type ExecResult, type VmInfo } from '@milibot/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CODEX_LOGIN_STATUS_CMD, CodexInstaller } from '../../../src/runtime/providers/cli-engines/codex'
import { CliEngineRoutes } from '../../../src/runtime/providers/cli-routes'
import { createPlaceholderVm, type VmController } from '../../../src/runtime/vm/controller'
import { WorkspaceStore } from '../../../src/runtime/workspace-store'
import { openWorkspaceDb } from '../../../src/workspace-db/open'
import { seedWorkspace } from '../../../src/workspace-db/seed'

type Exec = { user?: string; cmd: string }

let store: WorkspaceStore

beforeEach(() => {
  store = new WorkspaceStore(openWorkspaceDb(':memory:'), () => 1_000)
  seedWorkspace(store, 'en')
})

function fakeVm(
  answer: (req: Exec) => Partial<ExecResult>,
  procs: Array<{ label: string; running: boolean }> = [],
) {
  let state: VmInfo['state'] = 'running'
  const exec = vi.fn(
    async (req: Exec) => ({ code: 0, signal: null, stdout: '', stderr: '', ...answer(req) }) as ExecResult,
  )
  const guest = {
    exec,
    listProcs: async () => ({ procs }),
    startProc: async (spec: { label: string }) => {
      procs.push({ label: spec.label, running: true })
      return { id: 'p1' }
    },
  }
  const start = vi.fn(async () => undefined)
  const vm: VmController = {
    ...createPlaceholderVm(),
    status: () => ({ state, desktops: 1 }) as VmInfo,
    subscribe: () => () => undefined,
    runningGuest: () => guest as never,
    start,
    provisionBot: async () => undefined,
  }
  return { vm, exec, procs, start, setState: (next: VmInfo['state']) => (state = next) }
}

function routes(vm: VmController, installer?: CodexInstaller, now?: () => number) {
  const codexInstaller = installer ?? new CodexInstaller({ vm, needed: () => true, log: () => {} })
  return new CliEngineRoutes({
    store,
    vm,
    runtimes: { claude_code: { name: 'claude-code' }, codex: { name: 'codex', installer: codexInstaller } },
    now,
    log: () => {},
  }).handlers()
}

const args = <E extends 'claude_code' | 'codex'>(engine: E) => ({
  params: { workspaceId: 'ws', engine },
  query: undefined,
  body: undefined,
})

describe('Claude Code through the CLI routes', () => {
  it('asks the CLI in the running VM whether the agent account is logged in, never booting it', async () => {
    const outputs = [
      '{"loggedIn": true}',
      'warning: something\n{"loggedIn": true, "authMethod": "claude.ai", "email": "x@y.z"}',
      'command not found',
    ]
    const { vm, exec, setState } = fakeVm(() => ({ stdout: outputs.shift() ?? '' }))
    setState('stopped')
    const handlers = routes(vm)
    expect(await handlers.getCliLoginStatus(args('claude_code'))).toEqual({
      loggedIn: null,
      terminalOpen: null,
      loggedInElsewhere: false,
    })
    expect(exec).not.toHaveBeenCalled()
    setState('running')
    expect(await handlers.getCliLoginStatus(args('claude_code'))).toMatchObject({
      loggedIn: true,
      terminalOpen: false,
    })
    expect(await handlers.getCliLoginStatus(args('claude_code'))).toMatchObject({ loggedIn: true })
    expect(await handlers.getCliLoginStatus(args('claude_code'))).toMatchObject({ loggedIn: null })
    expect(exec).toHaveBeenCalledTimes(3)
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'agent', cmd: 'claude auth status --json' }),
    )
  })

  it("reports the first bot's login terminal and a login made from a bot's own account", async () => {
    const chief = store.bots.first()!
    let agentLoggedIn = false
    let botLoggedIn = false
    const procs = [
      { label: `login:claude:${chief.displayNum}`, running: true },
      { label: `login:claude:${chief.displayNum + 7}`, running: true },
    ]
    const { vm, exec } = fakeVm(
      ({ user }) => ({
        stdout: JSON.stringify({ loggedIn: user === 'agent' ? agentLoggedIn : botLoggedIn }),
      }),
      procs,
    )
    let clock = 0
    const handlers = routes(vm, undefined, () => clock)

    expect(await handlers.getCliLoginStatus(args('claude_code'))).toEqual({
      loggedIn: false,
      terminalOpen: true,
      loggedInElsewhere: false,
    })
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({ user: `bot-${chief.slug}`, cmd: expect.stringContaining('claude-real') }),
    )

    botLoggedIn = true
    procs[0]!.running = false
    clock = 5_000
    expect(await handlers.getCliLoginStatus(args('claude_code'))).toEqual({
      loggedIn: false,
      terminalOpen: false,
      loggedInElsewhere: false,
    })
    clock = 10_000
    expect(await handlers.getCliLoginStatus(args('claude_code'))).toMatchObject({ loggedInElsewhere: true })

    agentLoggedIn = true
    const calls = exec.mock.calls.length
    expect(await handlers.getCliLoginStatus(args('claude_code'))).toMatchObject({
      loggedIn: true,
      loggedInElsewhere: false,
    })
    expect(exec.mock.calls.slice(calls).map(([r]) => r.user)).toEqual(['agent'])
  })

  it('opens `claude` on the first bot desktop, starting a stopped VM instead', async () => {
    const chief = store.bots.first()!
    const { vm, procs, start, setState } = fakeVm(() => ({}))
    const handlers = routes(vm)
    setState('stopped')
    await expect(handlers.openCliLoginTerminal({ ...args('claude_code'), body: {} })).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'vm_not_running' },
    })
    expect(start).toHaveBeenCalledTimes(1)
    setState('running')
    expect(await handlers.openCliLoginTerminal({ ...args('claude_code'), body: {} })).toEqual({
      botId: chief.id,
    })
    expect(await handlers.openCliLoginTerminal({ ...args('claude_code'), body: {} })).toEqual({
      botId: chief.id,
    })
    expect(procs).toEqual([{ label: `login:claude:${chief.displayNum}`, running: true }])
  })

  it('has no installer, and keeps its compact system prompt switch', async () => {
    const handlers = routes(fakeVm(() => ({})).vm)
    await expect(handlers.getCliInstall(args('claude_code'))).rejects.toMatchObject({
      code: 'unsupported',
      details: { engine: 'claude_code', capability: 'installer' },
    })
    await expect(handlers.installCli(args('claude_code'))).rejects.toMatchObject({ code: 'unsupported' })
    expect(await handlers.getCliSettings(args('claude_code'))).toEqual({
      rotateIdleMinutes: 55,
      rotateContextTokens: 60_000,
      compactSystemPrompt: true,
    })
    expect(
      await handlers.updateCliSettings({
        ...args('claude_code'),
        body: { compactSystemPrompt: false, rotateIdleMinutes: 30 },
      }),
    ).toMatchObject({ compactSystemPrompt: false, rotateIdleMinutes: 30 })
    expect(store.settings.get('claude_code.compact_system_prompt', true)).toBe(false)
  })
})

describe('Codex through the CLI routes', () => {
  it('reports the login and opens `codex login` as agent once the CLI is installed', async () => {
    const chief = store.bots.first()!
    let loggedIn = false
    const { vm, procs, exec } = fakeVm((req) => {
      if (req.user === 'root') return { stdout: `codex-cli ${CODEX_VERSION}\n` }
      if (req.cmd === CODEX_LOGIN_STATUS_CMD) return { code: loggedIn ? 0 : 1 }
      return {}
    })
    const handlers = routes(vm)
    expect(await handlers.getCliLoginStatus(args('codex'))).toEqual({
      loggedIn: false,
      terminalOpen: false,
      loggedInElsewhere: false,
    })
    expect(await handlers.openCliLoginTerminal({ ...args('codex'), body: {} })).toEqual({ botId: chief.id })
    expect(exec.mock.calls.filter(([r]) => r.user === 'root')).toHaveLength(1)
    expect(procs).toEqual([{ label: `login:codex:${chief.displayNum}`, running: true }])
    loggedIn = true
    expect(await handlers.getCliLoginStatus(args('codex'))).toEqual({
      loggedIn: true,
      terminalOpen: true,
      loggedInElsewhere: false,
    })
  })

  it('refuses the login terminal while the CLI cannot be installed, keeping why', async () => {
    const { vm } = fakeVm((req) =>
      req.user === 'root' ? { code: 1, stderr: 'npm ERR! network' } : { code: 1 },
    )
    const handlers = routes(vm)
    await expect(handlers.openCliLoginTerminal({ ...args('codex'), body: {} })).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'cli_install_failed' },
    })
    expect(await handlers.getCliInstall(args('codex'))).toMatchObject({
      version: null,
      expected: CODEX_VERSION,
      error: 'npm ERR! network',
    })
  })

  it('installs through the route and keeps rotation settings of its own', async () => {
    const { vm } = fakeVm((req) => (req.user === 'root' ? { stdout: `codex-cli ${CODEX_VERSION}\n` } : {}))
    const handlers = routes(vm)
    expect(await handlers.installCli(args('codex'))).toEqual({
      version: CODEX_VERSION,
      expected: CODEX_VERSION,
      installing: false,
      error: null,
    })
    expect(await handlers.getCliSettings(args('codex'))).toEqual({
      rotateIdleMinutes: 55,
      rotateContextTokens: 60_000,
    })
    await handlers.updateCliSettings({ ...args('codex'), body: { rotateContextTokens: 80_000 } })
    expect(store.settings.get('codex.rotate_context_tokens', 0)).toBe(80_000)
    expect(store.settings.get('claude_code.rotate_context_tokens', 0)).toBe(0)
    await expect(
      handlers.updateCliSettings({ ...args('codex'), body: { compactSystemPrompt: true } }),
    ).rejects.toMatchObject({
      code: 'unsupported',
      details: { engine: 'codex', capability: 'compactSystemPrompt' },
    })
  })
})
