import type { BotSkill, Skill } from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import type { WorkspaceRuntime } from '../../../src/runtime/runtime'
import { seedWorkspace } from '../../../src/workspace-db/seed'
import { bootRuntime, type RuntimeHarness, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'

let h: RuntimeHarness
let runtime: WorkspaceRuntime
let firstBotId: string

const tempDir = useTempDir('skill-store')
afterEach(stopRuntimes)

async function start() {
  h = await bootRuntime({ dir: tempDir(), vm: false, script: () => ({ text: 'ok' }) })
  ;({ runtime, botId: firstBotId } = h)
}

const call: RuntimeHarness['call'] = (...args) => h.call(...args)

describe('team management', () => {
  it('stays with the bot it was given to when the first bot is deleted', async () => {
    await start()
    const botSkill = (botId: string) =>
      call<BotSkill[]>('listBotSkills', { botId }).then((all) =>
        all.find((s) => s.skill.id === 'builtin:team-management'),
      )
    expect(await botSkill(firstBotId)).toMatchObject({ enabled: true, active: true })
    const ana = runtime.store.bots.create({ name: 'Ana', label: 'Finance', systemPrompt: '' })
    expect(await botSkill(ana.id)).toMatchObject({ enabled: false, active: false })
    runtime.store.deleteBot(firstBotId)
    expect(await botSkill(ana.id)).toMatchObject({ enabled: false, active: false })
    expect(
      (await call<Skill[]>('listSkills')).find((s) => s.id === 'builtin:team-management')?.enabledFor,
    ).toEqual([])
  })

  it('never overrides the user’s switch when the workspace is seeded again', async () => {
    await start()
    const db = runtime.store.db
    const row = () =>
      db
        .prepare(
          "SELECT enabled FROM bot_skill_prefs WHERE bot_id = ? AND skill_id = 'builtin:team-management'",
        )
        .get(firstBotId) as { enabled: number } | undefined
    expect(row()?.enabled).toBe(1)
    db.prepare('UPDATE bot_skill_prefs SET enabled = 0').run()
    seedWorkspace(runtime.store, 'en')
    expect(row()?.enabled).toBe(0)
  })
})
