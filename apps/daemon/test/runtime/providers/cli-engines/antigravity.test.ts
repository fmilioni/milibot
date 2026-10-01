import { createHash } from 'node:crypto'

import { ANTIGRAVITY_DOWNLOADS, ANTIGRAVITY_VERSION, type ExecResult, type VmInfo } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import {
  antigravityHost,
  AntigravityInstaller,
  antigravityLoggedIn,
  parseAntigravityInstall,
  readAntigravityImages,
} from '../../../../src/runtime/providers/cli-engines/antigravity'
import { AGY_MCP_BRIDGE_SCRIPT } from '../../../../src/runtime/providers/cli-engines/scripts/agy-mcp-bridge.generated'
import { INSTALL_ANTIGRAVITY_SCRIPT } from '../../../../src/runtime/providers/cli-engines/scripts/install-antigravity.generated'

type Exec = {
  user?: string
  cmd: string
  env?: Record<string, string>
  stdin?: string
  maxOutputBytes?: number
}

const bridgeSha = createHash('sha256').update(AGY_MCP_BRIDGE_SCRIPT).digest('hex')
const installed = `${ANTIGRAVITY_VERSION}\n${bridgeSha}  /usr/local/lib/milibot/agy-mcp-bridge.js\n`

function guest(answer: (req: Exec) => Partial<ExecResult>) {
  const execs: Exec[] = []
  return {
    execs,
    exec: async (req: Exec) => {
      execs.push(req)
      return { code: 0, signal: null, stdout: '', stderr: '', ...answer(req) } as ExecResult
    },
  }
}

const usageJson = JSON.stringify({
  status: 'SUCCESS',
  command: { data: { groups: [{ buckets: [{ id: 'gemini-5h', remaining_fraction: 0.5 }] }] } },
})

describe('Antigravity in the VM', () => {
  it('installs the pinned build as root, with the MCP bridge on stdin', async () => {
    const g = guest((req) => (req.user === 'root' ? { stdout: `AGY=installed\n${installed}` } : {}))
    const vm = {
      status: () => ({ state: 'running' }) as VmInfo,
      subscribe: () => () => undefined,
      runningGuest: () => g,
    }
    const installer = new AntigravityInstaller({ vm: vm as never, needed: () => true, log: () => undefined })
    await installer.ready()
    expect(g.execs).toHaveLength(1)
    expect(g.execs[0]).toMatchObject({
      user: 'root',
      cmd: INSTALL_ANTIGRAVITY_SCRIPT,
      stdin: AGY_MCP_BRIDGE_SCRIPT,
      env: {
        AGY_VERSION: ANTIGRAVITY_VERSION,
        AGY_SHA_AARCH64: ANTIGRAVITY_DOWNLOADS.aarch64.sha512,
        AGY_REAL: '/usr/local/lib/milibot/agy-real',
        AGY_AGENTS_DIR: 'agy-agents',
      },
    })
    expect((await installer.status()).version).toBe(ANTIGRAVITY_VERSION)
  })

  it('counts an outdated bridge as not installed', () => {
    expect(parseAntigravityInstall(installed)).toBe(ANTIGRAVITY_VERSION)
    expect(parseAntigravityInstall(`${ANTIGRAVITY_VERSION}\n${'0'.repeat(64)}  bridge.js\n`)).toBeNull()
    expect(parseAntigravityInstall(`1.0.0\n${bridgeSha}  bridge.js\n`)).toBeNull()
  })

  it('tells signed in from waiting for a sign-in, from /usage alone', async () => {
    expect(await antigravityLoggedIn(guest(() => ({ stdout: usageJson })))).toBe(true)
    expect(
      await antigravityLoggedIn(
        guest(() => ({ code: 124, stdout: 'Authentication required. Please visit the URL to log in:' })),
      ),
    ).toBe(false)
    expect(await antigravityLoggedIn(guest(() => ({ code: 1, stderr: 'agy: not found' })))).toBeNull()
    const test = await antigravityHost.test(
      guest((req) => (req.cmd.includes('/usage') ? { stdout: '' } : {})),
      {
        authMode: 'subscription',
      },
    )
    expect(test).toEqual({ ok: false, error: 'Antigravity did not answer in the VM' })
  })

  it("reads a drawing turn's pictures, refusing unsafe names", async () => {
    const g = guest(() => ({
      stdout: `fox_1790888667262.jpg ${Buffer.from('jpeg').toString('base64')}\nnotes.txt abc\n`,
    }))
    const conversation = '377181b5-d1bb-4bd7-adfc-aad9e6b6d82e'
    const images = await readAntigravityImages(g, conversation, ['fox', '../etc'])
    expect(images).toEqual([{ bytes: new Uint8Array(Buffer.from('jpeg')), mediaType: 'image/jpeg' }])
    expect(g.execs[0]).toMatchObject({ user: 'agent', env: { CONVERSATION: conversation, NAMES: 'fox' } })
    expect(await readAntigravityImages(g, '../x', ['fox'])).toEqual([])
    expect(g.execs).toHaveLength(1)
  })

  it('is a subscription-only engine with an image model and an on-demand quota', () => {
    expect(antigravityHost.signIn('subscription', null, null)).toEqual({ env: {} })
    expect(antigravityHost.imageModel?.modelId).toBe('antigravity-image')
    expect(antigravityHost.quota?.parse(usageJson)).toEqual([
      { id: 'five_hour', utilization: 0.5, resetsAt: null },
    ])
    expect(antigravityHost.efforts('gemini-3.1-pro')).toEqual(['low', 'high'])
  })
})
