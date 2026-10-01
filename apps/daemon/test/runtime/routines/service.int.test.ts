import type { DefaultAgentHost } from '@milibot/agent'
import type { FakeProvider, FakeStep } from '@milibot/agent/testing'
import type { Message, Routine, WorkspaceEvent } from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { bootRuntime, type RuntimeHarness, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'

let h: RuntimeHarness
let host: DefaultAgentHost
let events: WorkspaceEvent[]
let chiefId: string
let chiefDm: string
let provider: FakeProvider

const dir = useTempDir('routines')
afterEach(stopRuntimes)

async function boot(script: FakeStep[]) {
  const steps = [...script]
  h = await bootRuntime({
    dir: dir(),
    vm: false,
    script: (request) => (request.tools.length === 0 ? { text: 'Hi!' } : (steps.shift() ?? { text: 'ok' })),
  })
  ;({ host, events, provider, botId: chiefId, dm: chiefDm } = h)
  await host.idle()
}

const call: RuntimeHarness['call'] = (...args) => h.call(...args)

async function messages(): Promise<Message[]> {
  return (
    await call<{ messages: Message[] }>('listMessages', { conversationId: chiefDm }, undefined, {
      limit: 100,
    })
  ).messages
}

describe('routines through the workspace runtime', () => {
  it('a bot creates a routine from the chat; "run now" runs it as a turn in its DM', async () => {
    await boot([
      {
        toolCalls: [
          {
            name: 'routine_create',
            arguments: {
              name: 'Daily summary',
              schedule: 'weekdays 6:30pm',
              prompt: 'Summarize what was done today.',
            },
          },
        ],
      },
      { text: 'Done: every weekday at 6:30pm.' },
      { text: 'Today: 3 tasks finished.' },
    ])
    await call(
      'postMessage',
      { conversationId: chiefDm },
      { content: 'send me a summary on weekdays at 6:30pm' },
    )
    await host.idle()

    const [routine] = await call<Routine[]>('listRoutines', {}, undefined, { botId: chiefId })
    expect(routine).toMatchObject({
      name: 'Daily summary',
      cron: '30 18 * * 1-5',
      enabled: true,
      botId: chiefId,
    })
    expect((await messages()).find((m) => m.payload?.type === 'routine_created')?.payload).toMatchObject({
      routineId: routine?.id,
      cron: '30 18 * * 1-5',
    })

    await call<Routine>('runRoutine', { routineId: routine?.id ?? '' })
    await host.idle()
    const all = await messages()
    const line = all.findIndex((m) => m.payload?.type === 'routine_run')
    expect(line).toBeGreaterThan(-1)
    expect(all.slice(line).some((m) => m.content === 'Today: 3 tasks finished.')).toBe(true)
    expect(all[line]).toMatchObject({ kind: 'card', payload: { name: 'Daily summary', manual: true } })
    const lastInput = provider.requests.at(-1)?.messages.at(-1)
    expect(lastInput?.role).toBe('user')
    expect(JSON.stringify(lastInput?.content)).toContain(
      'Routine instructions:\\nSummarize what was done today.',
    )
    expect(events.filter((e) => e.type === 'turn.finished').map((e) => e.payload)).toContainEqual({
      botId: chiefId,
      conversationId: chiefDm,
      turnId: expect.any(String),
      trigger: 'routine',
      outcome: 'done',
      reply: 'Today: 3 tasks finished.',
      routine: { id: routine?.id, name: 'Daily summary' },
    })
    const [after] = await call<Routine[]>('listRoutines')
    expect(after?.lastStatus).toBe('ok')
    expect(events.some((e) => e.type === 'routine.updated' && e.payload.routine.lastStatus === 'ok')).toBe(
      true,
    )
  })

  it('validates schedules on the API and edits, pauses and deletes routines', async () => {
    await boot([])
    await expect(
      call('createRoutine', { botId: chiefId }, { name: 'X', prompt: 'Do it.', cron: '* * * * *' }),
    ).rejects.toMatchObject({ code: 'validation_failed' })
    const created = await call<Routine>(
      'createRoutine',
      { botId: chiefId },
      { name: 'Backup', prompt: 'Run the backup.', cron: '0  3 * * *' },
    )
    expect(created.cron).toBe('0 3 * * *')
    const paused = await call<Routine>('updateRoutine', { routineId: created.id }, { enabled: false })
    expect(paused).toMatchObject({ enabled: false, nextRunAt: null })
    await call('deleteRoutine', { routineId: created.id })
    expect(await call<Routine[]>('listRoutines')).toEqual([])
    expect(events.at(-1)).toEqual({
      type: 'routine.deleted',
      payload: { routineId: created.id, botId: chiefId },
    })
  })
})
