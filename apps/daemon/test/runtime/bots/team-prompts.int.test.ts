import type { DefaultAgentHost } from '@milibot/agent'
import type { CompletionRequest } from '@milibot/agent/llm'
import type { FakeProvider, FakeStep } from '@milibot/agent/testing'
import type { Bot, Message, PromptVersion } from '@milibot/shared'
import { PERSONA_MAX_TOKENS } from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import type { WorkspaceRuntime } from '../../../src/runtime/runtime'
import { bootRuntime, type RuntimeHarness, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'

let h: RuntimeHarness
let runtime: WorkspaceRuntime
let host: DefaultAgentHost
let provider: FakeProvider
let chiefDm: string
let anaId: string
let anaDm: string
/** The tool call the next user message makes the bot send. */
let pending: { name: string; arguments: Record<string, unknown> } | null = null

const ANA_PROMPT =
  'You are Ana, the finance specialist of the team. You track expenses, reconcile the bank statements every ' +
  'week, prepare the monthly report with charts and flag any payment that looks unusual before it is made.'

const dir = useTempDir('team-prompts')
afterEach(stopRuntimes)

function script(request: CompletionRequest): FakeStep {
  if (request.messages.at(-1)?.role === 'tool') return { text: 'ok' }
  const next = pending
  pending = null
  return next ? { toolCalls: [next] } : { text: 'hello' }
}

async function boot() {
  h = await bootRuntime({ dir: dir(), vm: false, script, host: { compaction: false } })
  ;({ runtime, host, provider, dm: chiefDm } = h)
  await host.idle()
  const ana = runtime.store.bots.create({ name: 'Ana', label: 'Finance', systemPrompt: ANA_PROMPT })
  anaId = ana.id
  anaDm = runtime.store.conversations.create({ type: 'direct', botIds: [ana.id] }).id
}

const call: RuntimeHarness['call'] = (...args) => h.call(...args)

async function send(name: string, args: Record<string, unknown>, conversationId = chiefDm) {
  pending = { name, arguments: args }
  await call('postMessage', { conversationId }, { content: 'go' })
  await host.idle()
}

const ana = () => runtime.store.bots.list().find((b) => b.id === anaId) as Bot
const versions = () => call<PromptVersion[]>('listPromptVersions', { botId: anaId })

const lastToolResult = () =>
  (provider.requests.at(-1)?.messages ?? [])
    .filter((m) => m.role === 'tool')
    .flatMap((m) => m.content.map((p) => (p.type === 'text' ? p.text : '')))
    .join('\n')

describe('get_bot', () => {
  it('gives a team manager the whole role section; other bots do not have it', async () => {
    await boot()
    await send('get_bot', { bot: 'ana' })
    const result = lastToolResult()
    expect(ANA_PROMPT.length).toBeGreaterThan(160)
    expect(result).toContain(`Ana (id ${anaId}, label "Finance"`)
    expect(result).toMatch(new RegExp(`Role section \\(~\\d+ of ${PERSONA_MAX_TOKENS} tokens\\):`))
    expect(result).toContain(`<role_section>\n${ANA_PROMPT}\n</role_section>`)

    await send('get_bot', { bot: 'Ana' }, anaDm)
    expect(lastToolResult()).toContain('Not executed: get_bot belongs to a skill that is turned off for you')
  })
})

describe('update_bot with patch', () => {
  it('applies exact replacements in order, versions them and can be undone', async () => {
    await boot()
    await send('update_bot', {
      bot: 'Ana',
      patch: [
        { old_text: 'You track expenses', new_text: 'You track expenses and accounts payable' },
        { old_text: '', new_text: 'Always show the math.' },
      ],
      reason: 'The user asked Ana to also handle accounts payable.',
    })
    const expected = `${ANA_PROMPT.replace('You track expenses', 'You track expenses and accounts payable')}\nAlways show the math.`
    expect(lastToolResult()).toContain('Updated the prompt of Ana')
    expect(ana().systemPrompt).toBe(expected)
    const [latest] = await versions()
    expect(latest).toMatchObject({ authorType: 'bot', current: true, text: expected })

    await call('undoPromptVersion', { versionId: latest?.id as string })
    expect(ana().systemPrompt).toBe(ANA_PROMPT)
  })

  it('changes nothing, not even the name, when an old_text does not match', async () => {
    await boot()
    const before = (await versions()).length
    await send('update_bot', {
      bot: 'Ana',
      name: 'Bia',
      patch: [
        { old_text: 'You track expenses', new_text: 'You track costs' },
        { old_text: 'not in the prompt', new_text: 'x' },
      ],
    })
    const result = lastToolResult()
    expect(result).toContain('"old_text" was not found in the role section of Ana (patch 2 of 2')
    expect(result).toContain('get_bot')
    expect(result).toContain('Nothing was changed.')
    expect(ana()).toMatchObject({ name: 'Ana', systemPrompt: ANA_PROMPT })
    expect(await versions()).toHaveLength(before)
  })

  it('refuses a patch that leaves the role section over the cap', async () => {
    await boot()
    const huge = 'Always double-check every number and write it down in the ledger. '.repeat(90)
    await send('update_bot', { bot: 'Ana', label: 'CFO', patch: [{ old_text: '', new_text: huge }] })
    expect(lastToolResult()).toContain(`over the limit of ${PERSONA_MAX_TOKENS}`)
    expect(ana()).toMatchObject({ label: 'Finance', systemPrompt: ANA_PROMPT })
  })

  it('refuses system_prompt and patch together', async () => {
    await boot()
    await send('update_bot', {
      bot: 'Ana',
      system_prompt: 'You are Ana.',
      patch: [{ old_text: 'Ana', new_text: 'Bia' }],
    })
    expect(lastToolResult()).toContain('Pass either "system_prompt" or "patch", not both.')
    expect(ana().systemPrompt).toBe(ANA_PROMPT)
  })

  it('in approval mode the patch applies only once the user confirms', async () => {
    await boot()
    await call('updateWorkspacePreferences', {}, { promptUpdates: 'approval' })
    await send('update_bot', {
      bot: 'Ana',
      patch: [{ old_text: 'with charts', new_text: 'with charts and a forecast' }],
      reason: 'The user wants a forecast in the report.',
    })
    expect(lastToolResult()).toContain("waits for the user's approval")
    expect(ana().systemPrompt).toBe(ANA_PROMPT)
    const list = await call<{ messages: Message[] }>('listMessages', { conversationId: chiefDm }, undefined, {
      limit: 100,
    })
    const card = list.messages.find((m) => m.payload?.type === 'confirmation')
    if (card?.payload?.type !== 'confirmation') throw new Error('expected a confirmation card')
    expect(card.payload).toMatchObject({ action: 'update_prompt', status: 'pending' })

    await call('resolveConfirmation', { confirmationId: card.payload.confirmationId }, { approved: true })
    expect(ana().systemPrompt).toBe(ANA_PROMPT.replace('with charts', 'with charts and a forecast'))
  })
})
