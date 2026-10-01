import { CODEX_VERSION, type ExecResult, type VmInfo } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { CodexInstaller, parseCodexVersion } from '../../../../src/runtime/providers/cli-engines/codex'
import { INSTALL_CODEX_SCRIPT } from '../../../../src/runtime/providers/cli-engines/scripts/install-codex.generated'

type Exec = { user?: string; cmd: string; env?: Record<string, string>; stdin?: string }

function fakeVm(answer: (req: Exec) => Partial<ExecResult>) {
  const execs: Exec[] = []
  const listeners: Array<(info: VmInfo) => void> = []
  let state: VmInfo['state'] = 'running'
  const procs: Array<{ label: string; running: boolean }> = []
  const guest = {
    exec: async (req: Exec) => {
      execs.push(req)
      return { code: 0, signal: null, stdout: '', stderr: '', ...answer(req) } as ExecResult
    },
    listProcs: async () => ({ procs }),
    startProc: async (spec: { label: string }) => {
      procs.push({ label: spec.label, running: true })
      return { id: 'p1' }
    },
  }
  const vm = {
    status: () => ({ state }) as VmInfo,
    subscribe: (fn: (info: VmInfo) => void) => {
      listeners.push(fn)
      return () => undefined
    },
    runningGuest: () => guest,
    start: async () => undefined,
    provisionBot: async () => undefined,
  }
  const setState = (next: VmInfo['state']) => {
    state = next
    for (const fn of listeners) fn({ state } as VmInfo)
  }
  return { vm, execs, procs, setState }
}

const log = () => undefined

describe('Codex in the VM', () => {
  it('installs the pinned version as root once the VM runs with a Codex provider', async () => {
    const { vm, execs, setState } = fakeVm((req) =>
      req.user === 'root' ? { stdout: `CODEX=installed\ncodex-cli ${CODEX_VERSION}\n` } : {},
    )
    let needed = false
    const installer = new CodexInstaller({
      vm: vm as never,
      needed: () => needed,
      log,
    })
    setState('stopped')
    installer.start()
    setState('running')
    await new Promise((r) => setTimeout(r, 1))
    expect(execs).toHaveLength(0)

    needed = true
    await installer.ensure()
    expect(execs).toHaveLength(1)
    expect(execs[0]).toMatchObject({
      user: 'root',
      cmd: INSTALL_CODEX_SCRIPT,
      env: { CODEX_VERSION, CODEX_REAL: '/usr/local/lib/milibot/codex-real' },
    })
    expect(await installer.status()).toEqual({
      version: CODEX_VERSION,
      expected: CODEX_VERSION,
      installing: false,
      error: null,
    })
    await installer.ensure()
    expect(execs).toHaveLength(1)
  })

  it('makes a Codex process wait for the install, and fail with why when it could not', async () => {
    let fails = true
    const { vm, execs } = fakeVm((req) =>
      req.user !== 'root'
        ? {}
        : fails
          ? { code: 1, stderr: 'no network' }
          : { stdout: `codex-cli ${CODEX_VERSION}\n` },
    )
    const installer = new CodexInstaller({ vm: vm as never, needed: () => true, log })
    await expect(installer.ready()).rejects.toThrow('Codex could not be installed in the VM: no network')
    fails = false
    await installer.ready()
    await installer.ready()
    expect(execs.filter((e) => e.user === 'root')).toHaveLength(2)
  })

  it('reads the version the CLI prints', () => {
    expect(parseCodexVersion('codex-cli 0.159.2\n')).toBe('0.159.2')
    expect(parseCodexVersion('bash: codex: command not found')).toBeNull()
  })
})
