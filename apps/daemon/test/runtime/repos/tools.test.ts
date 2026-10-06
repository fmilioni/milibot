import { sessionLaneKey } from '@milibot/agent'
import type { GuestExecRequest } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { CHECKOUT_SCRIPT } from '../../../src/runtime/repos/scripts/checkout.generated'
import { WorktreeStore } from '../../../src/runtime/repos/store'
import { RepoTools } from '../../../src/runtime/repos/tools'
import { WorkspaceStore } from '../../../src/runtime/workspace-store'
import { openWorkspaceDb } from '../../../src/workspace-db/open'

describe('repo_checkout', () => {
  it("records the work sessions that check out the bot's chat worktree", async () => {
    const db = openWorkspaceDb(':memory:')
    const store = new WorkspaceStore(db)
    const worktrees = new WorktreeStore(db)
    const bot = store.bots.create({ name: 'Ana' })
    const guest = {
      exec: (req: GuestExecRequest) =>
        Promise.resolve(
          req.cmd === CHECKOUT_SCRIPT
            ? { code: 0, stdout: `STATUS=created\nBRANCH=bot/${bot.slug}/fix\nBASE=main\n`, stderr: '' }
            : { code: 0, stdout: '', stderr: '' },
        ),
    }
    const tools = new RepoTools({ vm: { guest: () => Promise.resolve(guest as never) }, store, worktrees })
    const checkout = (laneKey?: string) =>
      tools.execute(
        {
          bot,
          conversationId: null,
          turnId: null,
          signal: new AbortController().signal,
          ...(laneKey ? { laneKey } : {}),
        },
        { id: 'call_1', name: 'repo_checkout', arguments: { repo: 'app', task: 'fix' } },
      )

    expect((await checkout()).isError).toBeFalsy()
    const row = worktrees.active(bot.id, 'app')
    expect(row?.sessionId).toBeNull()
    expect(worktrees.sessionsUsing(row?.id ?? '')).toEqual([])

    await checkout(sessionLaneKey(bot.id, 'ws_a'))
    await checkout(sessionLaneKey(bot.id, 'ws_a'))
    await checkout(`${sessionLaneKey(bot.id, 'ws_b')}:sub:1`)
    expect(worktrees.active(bot.id, 'app')?.id).toBe(row?.id)
    expect(worktrees.sessionsUsing(row?.id ?? '').sort()).toEqual(['ws_a', 'ws_b'])
  })
})
