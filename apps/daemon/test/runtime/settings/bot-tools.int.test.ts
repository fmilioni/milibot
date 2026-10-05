import type { CompletionRequest } from '@milibot/agent/llm'
import {
  type Message,
  USER_REQUEST_TIMEOUT_KEY,
  type WorkspaceEvent,
  type WorkspacePreferences,
} from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { bootRuntime, type RuntimeHarness, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'
import { until } from '../../support/wait'

type Step = { text?: string; toolCalls?: Array<{ name: string; arguments?: unknown }> }

let h: RuntimeHarness
let requests: CompletionRequest[]

const dir = useTempDir('settings-tools')
afterEach(stopRuntimes)

async function boot(script: Step[]) {
  requests = []
  h = await bootRuntime({
    dir: dir(),
    host: { compaction: false },
    script: (request) => {
      if (request.tools.length === 0) return { text: 'Hi!' }
      requests.push(request)
      return script[requests.length - 1] ?? { text: 'Done.' }
    },
  })
}

const update = (settings: Record<string, unknown>, reason?: string): Step => ({
  toolCalls: [{ name: 'workspace_settings_update', arguments: { settings, ...(reason ? { reason } : {}) } }],
})

/** Text results the bot got back, in order. */
function toolResults(): string[] {
  return requests
    .map((r) => r.messages.at(-1))
    .filter((m) => m?.role === 'tool')
    .map((m) => JSON.stringify(m?.content))
}

const preferences = () => h.call<WorkspacePreferences>('getWorkspacePreferences')

function preferenceEvents(): WorkspacePreferences[] {
  return h.events
    .filter(
      (e): e is Extract<WorkspaceEvent, { type: 'preferences.updated' }> => e.type === 'preferences.updated',
    )
    .map((e) => e.payload.preferences)
}

async function pendingCard(): Promise<
  Message & { payload: { confirmationId: string; params: Record<string, string> } }
> {
  let found: Message | undefined
  await until(() => {
    found = h
      .messages()
      .filter(
        (m) =>
          m.payload?.type === 'confirmation' &&
          m.payload.action === 'workspace_settings' &&
          m.payload.status === 'pending',
      )
      .at(-1)
    return found !== undefined
  }, 8000)
  return found as never
}

const resolve = (card: { payload: { confirmationId: string } }, approved: boolean) =>
  h.call<Message>('resolveConfirmation', { confirmationId: card.payload.confirmationId }, { approved })

async function ask(content: string) {
  await h.call('postMessage', { conversationId: h.dm }, { content })
}

describe('bots changing workspace settings', () => {
  it('reads and changes safe fields at once and tells the app', async () => {
    await boot([
      { toolCalls: [{ name: 'workspace_settings_get', arguments: {} }] },
      update({ maxParallelBots: 5, draftPrs: false, mutedBots: ['Theo-missing'] }),
      update({
        maxParallelBots: 5,
        draftPrs: false,
        commitName: '{bot} at work',
        notifyRoutines: 'attention',
      }),
      update({ maxParallelBots: 5 }),
      { text: 'Done.' },
    ])
    await ask('allow five bots at once and stop draft PRs')
    await h.host.idle()

    const results = toolResults()
    expect(results[0]).toContain('maxParallelBots = 3')
    expect(results[0]).toMatch(/spendWarnUsd = null \(no limit\).*\[needs confirmation\]/)
    expect(results[0]).toContain('Only the user changes payloadRetentionDays')
    expect(results[1]).toContain('mutedBots: no single bot matches')
    expect(results[2]).toContain(
      'Changed: notifyRoutines \\"always\\" → \\"attention\\"; maxParallelBots 3 → 5',
    )
    expect(results[2]).toContain('draftPrs true → false')
    expect(results[2]).toContain('commitName \\"{bot} (Milibot)\\" → \\"{bot} at work\\"')
    expect(results[3]).toContain('Nothing to change')

    expect(await preferences()).toMatchObject({
      maxParallelBots: 5,
      draftPrs: false,
      commitName: '{bot} at work',
      notifyRoutines: 'attention',
    })
    expect(preferenceEvents()).toHaveLength(1)
    expect(preferenceEvents()[0]).toMatchObject({ maxParallelBots: 5, draftPrs: false })
  })

  it('mutes bots by name, and the settings screen tells the app too', async () => {
    const script: Step[] = []
    await boot(script)
    await h.call('updateWorkspacePreferences', {}, { notifications: false })
    expect(preferenceEvents().at(-1)).toMatchObject({ notifications: false })

    const bot = h.store.bots.get(h.botId)
    script.push(update({ mutedBots: [bot.name] }), { text: 'Done.' })
    await ask('mute yourself')
    await h.host.idle()
    expect(toolResults()[0]).toContain(`mutedBots [] → [\\"${bot.name}\\"]`)
    expect((await preferences()).mutedBots).toEqual([bot.id])
  })

  it('refuses fields outside the list and invalid values, changing nothing', async () => {
    await boot([
      update({ payloadRetentionDays: 1, foo: true }),
      update({ maxParallelBots: 99 }),
      update({ notifyRoutines: 'never' }),
      { toolCalls: [{ name: 'workspace_settings_update', arguments: { settings: [] } }] },
      { text: 'Done.' },
    ])
    await ask('change things')
    await h.host.idle()

    const results = toolResults()
    expect(results[0]).toContain('\\"payloadRetentionDays\\", \\"foo\\" are not a setting you can change')
    expect(results[0]).toMatch(/Fields you may change: notifications, notifyRoutines, mutedBots/)
    expect(results[1]).toMatch(/maxParallelBots: .*10/)
    expect(results[2]).toContain('notifyRoutines')
    expect(results[3]).toContain('\\"settings\\" must be an object')
    expect(await preferences()).toMatchObject({ maxParallelBots: 3, notifyRoutines: 'always' })
    expect(preferenceEvents()).toEqual([])
  })

  it('applies spend limits and merging only after the user approves the card', async () => {
    await boot([
      update({ spendWarnUsd: 5, autoMergePrs: true, maxParallelBots: 4 }, 'Keep costs in check'),
      { text: 'Done.' },
    ])
    await ask('warn me at $5 a day and let bots merge')
    const card = await pendingCard()
    expect(card.content).toContain('wants to change workspace settings: Keep costs in check')
    expect(JSON.parse(card.payload.params.changes as string)).toEqual([
      { field: 'spendWarnUsd', from: null, to: 5 },
      { field: 'autoMergePrs', from: false, to: true },
    ])
    expect(await preferences()).toMatchObject({ spendWarnUsd: null, autoMergePrs: false, maxParallelBots: 4 })

    const resolved = await resolve(card, true)
    expect(resolved.payload).toMatchObject({ status: 'approved' })
    await h.host.idle()
    expect(await preferences()).toMatchObject({ spendWarnUsd: 5, autoMergePrs: true })
    expect(preferenceEvents().at(-1)).toMatchObject({ spendWarnUsd: 5, autoMergePrs: true })
    const result = toolResults()[0]
    expect(result).toContain('Changed: maxParallelBots 3 → 4')
    expect(result).toContain(
      'The user approved it. Changed: spendWarnUsd null (no limit) → 5; autoMergePrs false → true',
    )
  })

  it('changes nothing when the user rejects the card', async () => {
    await boot([update({ promptUpdates: 'auto', spendPauseUsd: 20 }), { text: 'Done.' }])
    await h.call('updateWorkspacePreferences', {}, { promptUpdates: 'approval' })
    const before = preferenceEvents().length
    await ask('pause bots at $20 and stop asking about prompts')
    const card = await pendingCard()
    await resolve(card, false)
    await h.host.idle()

    expect(toolResults()[0]).toContain(
      'The user rejected the change of spendPauseUsd, promptUpdates. Nothing changed.',
    )
    expect(await preferences()).toMatchObject({ promptUpdates: 'approval', spendPauseUsd: null })
    expect(preferenceEvents()).toHaveLength(before)
  })

  it('tells the bot in a new turn when the user decides after the tool stopped waiting', async () => {
    await boot([update({ autoMergePrs: true }), { text: 'Waiting for you.' }, { text: 'Noted.' }])
    h.store.settings.set(USER_REQUEST_TIMEOUT_KEY, 0.01)
    await ask('let bots merge')
    const card = await pendingCard()
    await h.host.idle()
    expect(toolResults()[0]).toContain('has not decided yet')

    await resolve(card, true)
    await until(() => requests.length >= 3, 8000)
    await h.host.idle()
    expect(JSON.stringify(requests[2]?.messages)).toContain(
      '[Milibot] The user approved it. Changed: autoMergePrs false → true',
    )
    expect((await preferences()).autoMergePrs).toBe(true)
  })
})
