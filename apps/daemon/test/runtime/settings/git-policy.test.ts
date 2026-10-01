import { describe, expect, it } from 'vitest'

import { gitPolicyFile, GitPolicySync } from '../../../src/runtime/settings/git-policy'
import { SYNC_GIT_POLICY_SCRIPT } from '../../../src/runtime/settings/scripts/sync-git-policy.generated'

describe('git policy file', () => {
  it('lists only session folders inside /workspace, once each', () => {
    expect(
      gitPolicyFile({
        draftPrs: false,
        autoMerge: false,
        allowMergeDirs: ['/workspace/sessions/b', '/workspace', '/tmp/x', '/workspace/a', '/workspace/a'],
      }),
    ).toBe('DRAFT_PRS=0\nAUTO_MERGE=0\nALLOW_MERGE_DIR=/workspace/a\nALLOW_MERGE_DIR=/workspace/sessions/b\n')
  })

  it('writes the policy when the VM is running and only again when it changed', async () => {
    const execs: Array<Record<string, unknown>> = []
    let state = 'running'
    const listeners = new Set<(info: { state: string }) => void>()
    let prefs = { draftPrs: true, autoMergePrs: false }
    const folders = ['/workspace/sessions/a']
    const sync = new GitPolicySync({
      vm: {
        status: () => ({ state }) as never,
        subscribe: (listener) => {
          listeners.add(listener as never)
          return () => listeners.delete(listener as never)
        },
        runningGuest: () =>
          ({
            exec: async (request: Record<string, unknown>) => {
              execs.push(request)
              return { code: 0, signal: null, stdout: 'POLICY=updated\n', stderr: '' }
            },
          }) as never,
      },
      preferences: () => prefs,
      mergePrFolders: () => folders,
      debounceMs: 1,
      log: () => undefined,
    })
    sync.start()
    await until(() => execs.length === 1)
    expect(execs[0]).toMatchObject({
      user: 'root',
      cmd: SYNC_GIT_POLICY_SCRIPT,
      env: { POLICY: 'DRAFT_PRS=1\nAUTO_MERGE=0\nALLOW_MERGE_DIR=/workspace/sessions/a\n' },
    })
    expect(execs[0]).not.toHaveProperty('stdin')
    sync.refresh()
    await new Promise((r) => setTimeout(r, 20))
    expect(execs).toHaveLength(1)
    prefs = { ...prefs, autoMergePrs: true }
    sync.refresh()
    await until(() => execs.length === 2)
    expect(execs[1]).toMatchObject({ env: { POLICY: 'DRAFT_PRS=1\nAUTO_MERGE=1\n' } })

    state = 'stopped'
    for (const l of listeners) l({ state })
    state = 'running'
    for (const l of listeners) l({ state })
    await until(() => execs.length === 3)
    sync.stop()
  })
})

async function until(check: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 2))
  }
}
