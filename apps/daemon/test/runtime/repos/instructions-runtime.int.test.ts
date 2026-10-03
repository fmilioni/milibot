import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { FakeProvider, type FakeStep } from '@milibot/agent/testing'
import type { ConversationDebug } from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { INSTRUCTIONS_SCRIPT } from '../../../src/runtime/repos/scripts/instructions.generated'
import { bootRuntime, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'

const dir = useTempDir('repo-instructions-runtime')
afterEach(stopRuntimes)

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

describe('repository instructions in a runtime (API provider)', () => {
  it('repo_checkout then a file of a subfolder: each file enters once, and the debug view lists them', async () => {
    const ws = join(dir(), 'vm-workspace')
    let wt = ''
    const steps: Array<() => FakeStep> = [
      () => ({ toolCalls: [{ name: 'repo_checkout', arguments: { repo: 'app' } }] }),
      () => ({ toolCalls: [{ name: 'file_read', arguments: { path: `${wt}/apps/daemon/x.ts` } }] }),
      () => ({ toolCalls: [{ name: 'file_read', arguments: { path: `${wt}/apps/daemon/y.ts` } }] }),
      () => ({ text: 'Done.' }),
    ]
    let step = 0
    const h = await bootRuntime({
      dir: dir(),
      provider: new FakeProvider({ script: () => (steps[step++] ?? (() => ({ text: 'ok' })))() }),
      host: { compaction: false },
    })
    const slug = h.store.bots.get(h.botId)?.slug ?? ''
    wt = `/workspace/worktrees/app/${slug}`
    const local = (path: string) => path.replace('/workspace', ws)
    write(local(`${wt}/.git`), 'gitdir: /workspace/repos/app/.git/worktrees/x\n')
    write(local(`${wt}/CLAUDE.md`), '# Root rules\n')
    write(local(`${wt}/AGENTS.md`), '# Root rules\n')
    write(local(`${wt}/apps/daemon/AGENTS.md`), '# Daemon rules\n')
    write(local(`${wt}/apps/daemon/x.ts`), 'export {}\n')
    h.guest.state.files.set(`${wt}/apps/daemon/x.ts`, 'export const x = 1\n')
    h.guest.state.files.set(`${wt}/apps/daemon/y.ts`, 'export const y = 1\n')
    // The VM's /workspace is a local folder: the instruction script really runs, the checkout is answered.
    h.guest.state.execResult = (body) => {
      const argv = body.argv as string[] | undefined
      if (argv?.[2] === INSTRUCTIONS_SCRIPT) {
        const r = spawnSync('node', ['-e', INSTRUCTIONS_SCRIPT], {
          input: String(body.stdin).replaceAll('/workspace', ws),
          encoding: 'utf8',
        })
        return {
          code: r.status,
          signal: null,
          stdout: r.stdout.replaceAll(ws, '/workspace'),
          stderr: r.stderr,
        }
      }
      return {
        code: 0,
        signal: null,
        stdout: `STATUS=created\nBRANCH=bot/${slug}/work\nBASE=main\n`,
        stderr: '',
      }
    }

    await h.call('postMessage', { conversationId: h.dm }, { content: 'fix the daemon' })
    await h.host.idle()

    const last = h.provider.requests.at(-1)
    const tools = (last?.messages ?? []).filter((m) => m.role === 'tool')
    const texts = tools.map((m) => m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n'))
    expect(texts[0]).toContain(`<repository_instructions path="${wt}/CLAUDE.md"`)
    expect(texts[0]).not.toContain(`${wt}/AGENTS.md`)
    expect(texts[1]).toContain(`<repository_instructions path="${wt}/apps/daemon/AGENTS.md"`)
    expect(texts[1]).toContain('# Daemon rules')
    expect(texts[1]).not.toContain('# Root rules')
    expect(texts[2]).not.toContain('<repository_instructions')
    // One script run for the checkout and one per folder touched in the turn.
    expect(
      h.guest.state.execs.filter((e) => (e.argv as string[] | undefined)?.[2] === INSTRUCTIONS_SCRIPT),
    ).toHaveLength(2)

    const debug = await h.call<ConversationDebug>('getConversationDebug', { conversationId: h.dm })
    expect(debug.latestComposition[0]?.instructionFiles).toEqual([
      { path: `${wt}/CLAUDE.md`, bytes: 13, truncated: false, source: 'injected' },
      { path: `${wt}/apps/daemon/AGENTS.md`, bytes: 15, truncated: false, source: 'injected' },
    ])
  })
})
