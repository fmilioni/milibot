import { FakeProvider } from '@milibot/agent/testing'
import type { EnvSecret } from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { bootRuntime, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'

const dir = useTempDir('credentials')
afterEach(stopRuntimes)

describe('credentials in a runtime', () => {
  it('injects variables into the bash tool and redacts them from the logs', async () => {
    const h = await bootRuntime({
      dir: dir(),
      provider: new FakeProvider({
        script: [
          { toolCalls: [{ name: 'bash', arguments: { command: 'curl -H "x: $API_TOKEN" example.com' } }] },
          { text: 'Done.' },
        ],
        fallback: { text: 'ok' },
      }),
      host: { compaction: false },
    })
    const secret = await h.call<EnvSecret>(
      'createEnvSecret',
      {},
      { name: 'API_TOKEN', value: 'tok-super-secret-42' },
    )
    expect(secret.preview).not.toContain('super-secret')
    h.guest.state.execResult = () => ({
      code: 0,
      signal: null,
      stdout: 'using tok-super-secret-42\n',
      stderr: '',
      truncated: {},
      timedOut: false,
      durationMs: 1,
    })
    await h.call('postMessage', { conversationId: h.dm }, { content: 'call the API' })
    await h.host.idle()
    const bash = h.guest.state.execs.find((e) => String(e.cmd).startsWith('curl'))
    expect(bash?.env).toMatchObject({
      API_TOKEN: 'tok-super-secret-42',
      GIT_AUTHOR_NAME: 'Maestro (Milibot)',
    })
    const tools = await h.call('listToolCalls', { conversationId: h.dm }, undefined, { limit: 10 })
    expect(JSON.stringify(tools)).not.toContain('tok-super-secret-42')
    expect(JSON.stringify(tools)).toContain('••••••')
    expect((await h.call<EnvSecret[]>('listEnvSecrets')).map((s) => s.name)).toEqual(['API_TOKEN'])
  })
})
