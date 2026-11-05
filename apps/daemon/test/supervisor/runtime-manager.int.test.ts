import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RuntimeManager } from '../../src/supervisor/runtime-manager'
import { removeDir, tempDir } from '../support/temp'

/** Logs the computer it was started with, says it is ready and leaves when told to. */
const FAKE_RUNTIME = `import { appendFileSync } from 'node:fs'
appendFileSync(process.env.FAKE_RUNTIME_LOG, (process.env.MILIBOT_COMPUTER ?? '') + '\\n')
process.on('message', (message) => {
  if (message.type === 'shutdown') {
    process.exit(0)
  }
})
process.send({ type: 'ready' })
`

let dir: string
let manager: RuntimeManager

beforeEach(() => {
  dir = tempDir('runtime-manager')
  const entry = join(dir, 'fake-runtime.mjs')
  writeFileSync(entry, FAKE_RUNTIME)
  manager = new RuntimeManager({
    launcher: { entry, execArgv: [], env: { FAKE_RUNTIME_LOG: join(dir, 'starts') } },
    onEvent: () => {},
    onStatus: () => {},
    log: () => {},
  })
})

afterEach(async () => {
  await manager.stopAll()
  removeDir(dir)
})

const starts = (): string[] => readFileSync(join(dir, 'starts'), 'utf8').trim().split('\n')

describe('restarting a runtime', () => {
  it('holds requests until the new runtime runs, so none starts one from the old target', async () => {
    const vmTarget = { id: 'ws_1', dir, computer: 'vm' as const }
    await manager.ensure(vmTarget, 'en')
    let duringRestart: Promise<void> = Promise.resolve()

    await manager.restart('ws_1', 'en', {
      vm: 'keep',
      prepare: async () => {
        duringRestart = manager.ensure(vmTarget, 'en')
        await new Promise((resolve) => setTimeout(resolve, 20))
      },
      next: () => ({ ...vmTarget, computer: 'none' }),
    })
    await duringRestart

    expect(starts()).toEqual(['vm', 'none'])
    expect(manager.isRunning('ws_1')).toBe(true)
  })
})
