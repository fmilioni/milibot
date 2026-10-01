import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { DAEMON_ENV_VARS, readDaemonConfig, readRuntimeConfig } from '../../src/config/env'
import { RUNTIME_ENV } from '../../src/ipc/protocol'

/** Variables of the root CLAUDE.md table that another program reads (the desktop app, the VM scripts). */
const NOT_THE_DAEMONS = ['MILIBOT_DAEMON_EXTERNAL']

function documentedVariables(): string[] {
  const claudeMd = readFileSync(new URL('../../../../CLAUDE.md', import.meta.url), 'utf8')
  return claudeMd
    .split('\n')
    .filter((line) => line.startsWith('| `MILIBOT_'))
    .flatMap((line) => line.split('|')[1]?.match(/MILIBOT_[A-Z_]+/g) ?? [])
}

describe('daemon environment', () => {
  it('is the list the root CLAUDE.md documents', () => {
    const documented = documentedVariables().filter((name) => !NOT_THE_DAEMONS.includes(name))
    expect([...documented].sort()).toEqual([...DAEMON_ENV_VARS].sort())
  })

  it('has defaults and treats empty values as unset', () => {
    const config = readDaemonConfig({
      MILIBOT_DATA_DIR: '/data',
      MILIBOT_DAEMON_PORT: '',
      MILIBOT_FAKE_LLM: '',
    })
    expect(config).toMatchObject({
      dataRoot: '/data',
      port: null,
      logLevel: 'info',
      logRequests: false,
      secretStore: null,
      vmPortFirst: 24000,
      goldenImage: null,
      vmScripts: { cli: null, build: null },
    })
    expect(readDaemonConfig({ MILIBOT_LOG_LEVEL: 'debug', MILIBOT_VM_PORT_FIRST: '47600' })).toMatchObject({
      logLevel: 'debug',
      vmPortFirst: 47600,
    })
  })

  it('refuses values it cannot use', () => {
    expect(() => readDaemonConfig({ MILIBOT_SECRET_STORE: 'vault' })).toThrow(/MILIBOT_SECRET_STORE/)
    expect(() => readDaemonConfig({ MILIBOT_DAEMON_PORT: 'abc' })).toThrow(/MILIBOT_DAEMON_PORT/)
  })

  it('reads what the supervisor forks a runtime with', () => {
    expect(() => readRuntimeConfig({})).toThrow(/forked by the supervisor/)
    const config = readRuntimeConfig({
      [RUNTIME_ENV.workspaceId]: 'ws_a',
      [RUNTIME_ENV.workspaceDir]: '/data/workspaces/ws_a',
      [RUNTIME_ENV.language]: 'xx',
      [RUNTIME_ENV.vmPortBase]: '24100',
      [RUNTIME_ENV.background]: '1',
      MILIBOT_VM_AUTOSTART: '0',
      MILIBOT_FAKE_EMBEDDINGS: '1',
    })
    expect(config).toMatchObject({
      workspaceId: 'ws_a',
      workspaceName: 'ws_a',
      language: 'pt-BR',
      vmPortBase: 24100,
      background: true,
      closeBehavior: 'keep_running',
      vmDisabled: false,
      vmAutostart: false,
      fakeEmbeddings: true,
      fakeLlm: null,
    })
  })
})
