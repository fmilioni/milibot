import { describe, expect, it, vi } from 'vitest'

import {
  claudeCodeHost,
  loggedInAsBotUser,
  parseClaudeLoggedIn,
} from '../../../src/runtime/providers/cli-engines/claude-code'
import { openLoginTerminal } from '../../../src/runtime/providers/cli-login'
import type { GuestClient } from '../../../src/runtime/vm/guest-client'

describe('Claude login terminal', () => {
  it('opens `claude` as agent on the display, and never a second one while it runs', async () => {
    let procs: Array<{ id: string; label?: string; running: boolean }> = [
      { id: 'old', label: 'login:claude:2', running: false },
    ]
    const startProc = vi.fn(async (req: { label?: string }) => {
      procs = [...procs, { id: 'new', label: req.label, running: true }]
      return { id: 'new' }
    })
    const guest = { listProcs: async () => ({ procs }), startProc, exec: vi.fn() } as unknown as GuestClient

    expect(await openLoginTerminal(guest, claudeCodeHost.login, 2)).toBe('opened')
    expect(startProc).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'agent', display: 2, label: 'login:claude:2' }),
    )
    expect(startProc.mock.calls[0]![0]).toMatchObject({ argv: expect.arrayContaining(['claude; exec bash']) })
    expect(await openLoginTerminal(guest, claudeCodeHost.login, 2)).toBe('already_open')
    expect(startProc).toHaveBeenCalledTimes(1)
  })

  it("checks each bot user's own login through the binary behind the wrapper, ignoring failures", async () => {
    const exec = vi.fn(async ({ user }: { user: string }) => {
      if (user === 'bot-gone') throw new Error('unknown_user')
      return {
        code: 0,
        stdout: user === 'bot-lead' ? '{"loggedIn":true,"authMethod":"claude.ai"}' : '{"loggedIn":false}',
      }
    })
    const guest = { exec } as unknown as GuestClient
    expect(await loggedInAsBotUser(guest, ['gone', 'iris'])).toBe(false)
    expect(await loggedInAsBotUser(guest, ['gone', 'lead'])).toBe(true)
    expect(exec.mock.calls[0]![0]).toMatchObject({
      cmd: 'r=/usr/local/lib/milibot/claude-real; [ -x "$r" ] || r=claude; "$r" auth status --json',
    })
  })
})

describe('parseClaudeLoggedIn', () => {
  it('reads loggedIn from `claude auth status --json`', () => {
    expect(parseClaudeLoggedIn('{"loggedIn":true,"authMethod":"claude.ai"}')).toBe(true)
    expect(parseClaudeLoggedIn('{"loggedIn": false}\n')).toBe(false)
    expect(parseClaudeLoggedIn('Not logged in')).toBeNull()
    expect(parseClaudeLoggedIn('{"other":1}')).toBeNull()
  })
})
