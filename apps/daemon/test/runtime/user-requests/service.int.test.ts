import type { DefaultAgentHost } from '@milibot/agent'
import type { FakeProvider, FakeStep } from '@milibot/agent/testing'
import type { Bot, EnvSecret, Message, WorkspaceEvent } from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import type { WorkspaceRuntime } from '../../../src/runtime/runtime'
import type { FakeGuest } from '../../support/fake-guest'
import { bootRuntime, type RuntimeHarness, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'
import { until } from '../../support/wait'

const SECRET = 'Sup3r-S3cret-Bank!'

let h: RuntimeHarness
let runtime: WorkspaceRuntime
let host: DefaultAgentHost
let events: WorkspaceEvent[]
let guest: FakeGuest
let provider: FakeProvider
let chief: Bot
let chiefDm: string

const dir = useTempDir('requests')
afterEach(stopRuntimes)

async function boot(script: FakeStep[]) {
  h = await bootRuntime({ dir: dir(), script, fallback: { text: 'ok' }, host: { compaction: false } })
  ;({ runtime, host, events, guest, provider, dm: chiefDm } = h)
  chief = runtime.store.bots.get(h.botId)
}

const call: RuntimeHarness['call'] = (...args) => h.call(...args)

const messages = (): Message[] => h.messages()

function card(type: 'question' | 'secret_request'): Message | undefined {
  return messages().find((m) => m.payload?.type === type)
}

async function pendingCard(type: 'question' | 'secret_request'): Promise<Message> {
  await until(() => card(type)?.payload !== undefined)
  return card(type) as Message
}

function requestId(message: Message): string {
  const payload = message.payload
  if (payload?.type !== 'question' && payload?.type !== 'secret_request')
    throw new Error('not a request card')
  return payload.requestId
}

/** Tool results in the context of the model's last call (the current turn's tool calls, in order). */
function toolResults(): string[] {
  return (provider.requests.at(-1)?.messages ?? []).flatMap((m) =>
    m.role === 'tool' ? m.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])) : [],
  )
}

const question = {
  questions: [
    {
      header: 'Account',
      question: 'Which account should I use?',
      options: [
        { label: 'Personal', description: 'Everyday account', recommended: true },
        { label: 'Business' },
      ],
    },
    {
      header: 'Format',
      question: 'In which format?',
      options: [{ label: 'PDF' }, { label: 'Spreadsheet' }],
      multi_select: true,
    },
  ],
}

describe('ask_user', () => {
  it('waits for the answer from the card and continues the turn with it', async () => {
    await boot([{ toolCalls: [{ name: 'ask_user', arguments: question }] }, { text: 'Using Personal.' }])
    await call('postMessage', { conversationId: chiefDm }, { content: 'write the report' })
    const pending = await pendingCard('question')
    expect(pending).toMatchObject({ kind: 'card', authorBotId: chief.id })
    expect(pending.payload).toMatchObject({
      status: 'pending',
      questions: [
        { header: 'Account', options: [{ label: 'Personal', recommended: true }, { label: 'Business' }] },
        { multiSelect: true },
      ],
    })
    await until(() => events.some((e) => e.type === 'bot.status' && e.payload.detail === 'ask_user'))

    await expect(
      call('answerQuestion', { requestId: requestId(pending) }, { answers: [{ selected: ['Other'] }, {}] }),
    ).rejects.toThrow()
    const answered = await call<Message>(
      'answerQuestion',
      { requestId: requestId(pending) },
      { answers: [{ selected: ['Personal'] }, { selected: [], other: 'A plain CSV' }] },
    )
    expect(answered.payload).toMatchObject({
      status: 'answered',
      answers: [{ selected: ['Personal'] }, { selected: [], other: 'A plain CSV' }],
    })
    expect(answered.content).toContain('Which account should I use?\n→ Personal')
    await host.idle()
    const result = toolResults().at(-1) ?? ''
    expect(result).toContain('Answer: Personal — the option you recommended')
    expect(result).toContain('"A plain CSV" (own answer)')
    expect(messages().at(-1)?.content).toBe('Using Personal.')

    // Resolving again changes nothing.
    const again = await call<Message>(
      'answerQuestion',
      { requestId: requestId(pending) },
      { answers: [{ selected: ['Business'] }, { selected: ['PDF'] }] },
    )
    expect(again.payload).toMatchObject({ answers: [{ selected: ['Personal'] }, expect.anything()] })
  })

  it('a chat message answers a pending question without starting another turn', async () => {
    await boot([{ toolCalls: [{ name: 'ask_user', arguments: question }] }, { text: 'Right, business.' }])
    await call('postMessage', { conversationId: chiefDm }, { content: 'write the report' })
    await pendingCard('question')
    await call('postMessage', { conversationId: chiefDm }, { content: 'use the business account' })
    await host.idle()
    expect(card('question')?.payload).toMatchObject({ status: 'answered_in_chat' })
    expect(toolResults().at(-1)).toContain('they answered in the chat instead:\n\nuse the business account')
    expect(provider.requests).toHaveLength(2)
    expect(events.filter((e) => e.type === 'turn.finished')).toHaveLength(1)
  })

  it('after the wait times out, a later answer starts a user_answer turn', async () => {
    await boot([
      { toolCalls: [{ name: 'ask_user', arguments: question }] },
      { text: 'I will wait.' },
      { text: 'Got it: Business.' },
    ])
    runtime.store.settings.set('bots.user_request_timeout_seconds', 0.05)
    await call('postMessage', { conversationId: chiefDm }, { content: 'write the report' })
    await host.idle()
    expect(toolResults().at(-1)).toContain('has not answered yet')
    const pending = card('question') as Message
    expect(pending.payload).toMatchObject({ status: 'pending' })

    await call(
      'answerQuestion',
      { requestId: requestId(pending) },
      {
        answers: [{ selected: ['Business'] }, { selected: ['PDF', 'Spreadsheet'] }],
      },
    )
    await host.idle()
    const turns = events.flatMap((e) => (e.type === 'turn.finished' ? [e.payload.trigger] : []))
    expect(turns).toEqual(['user_message', 'user_answer'])
    const input = JSON.stringify(provider.requests.at(-1)?.messages.at(-1)?.content)
    expect(input).toContain('The user answered the question you asked earlier')
    expect(input).toContain('Answer: Business — not what you recommended (Personal)')
    expect(messages().at(-1)?.content).toBe('Got it: Business.')
  })

  it('stopping the bot expires the question; dismissing one tells the bot', async () => {
    await boot([
      { toolCalls: [{ name: 'ask_user', arguments: question }] },
      { toolCalls: [{ name: 'ask_user', arguments: question }] },
      { text: 'Going on without it.' },
    ])
    await call('postMessage', { conversationId: chiefDm }, { content: 'first' })
    const first = await pendingCard('question')
    await call('controlBot', { botId: chief.id }, { action: 'stop' })
    await host.idle()
    expect(messages().find((m) => m.id === first.id)?.payload).toMatchObject({
      status: 'expired',
      expiredReason: 'stopped',
    })

    await call('postMessage', { conversationId: chiefDm }, { content: 'second' })
    await until(() => messages().filter((m) => m.payload?.type === 'question').length === 2)
    const second = messages().findLast((m) => m.payload?.type === 'question') as Message
    const declined = await call<Message>('declineUserRequest', { requestId: requestId(second) })
    expect(declined.payload).toMatchObject({ status: 'declined' })
    await host.idle()
    expect(toolResults().at(-1)).toContain('dismissed the question')
  })
})

describe('request_secret', () => {
  it('the value reaches only the VM (stdin, screen input), never the database or the model', async () => {
    await boot([
      {
        toolCalls: [
          {
            name: 'request_secret',
            arguments: { name: 'BANK_PASSWORD', label: 'Bank password', reason: 'To log in to the bank' },
          },
        ],
      },
      { toolCalls: [{ name: 'computer', arguments: { action: 'type', text: '{{secret:BANK_PASSWORD}}' } }] },
      { toolCalls: [{ name: 'bash', arguments: { command: 'cat "$MILIBOT_SECRETS_DIR/BANK_PASSWORD"' } }] },
      { toolCalls: [{ name: 'list_secrets', arguments: {} }] },
      { toolCalls: [{ name: 'computer', arguments: { action: 'type', text: '{{secret:OTHER}}' } }] },
      { text: `Logged in. (the password was ${SECRET})` },
    ])
    guest.state.execResult = (body) => ({
      code: 0,
      signal: null,
      stdout: String(body.cmd).includes('BANK_PASSWORD') ? `${SECRET}\n` : '',
      stderr: '',
      truncated: {},
      timedOut: false,
      durationMs: 1,
    })
    await call('postMessage', { conversationId: chiefDm }, { content: 'pay the bill' })
    const pending = await pendingCard('secret_request')
    expect(pending.payload).toMatchObject({
      status: 'pending',
      name: 'BANK_PASSWORD',
      label: 'Bank password',
      reason: 'To log in to the bank',
      asEnv: false,
    })
    const answered = await call<Message>(
      'answerSecretRequest',
      { requestId: requestId(pending) },
      { value: SECRET, remember: false, scope: 'bot' },
    )
    expect(answered.payload).toMatchObject({ status: 'answered', remember: false, scope: 'bot' })
    await host.idle()

    // Written to the bot's secret files through stdin only.
    const encoded = Buffer.from(SECRET).toString('base64')
    const writes = guest.state.execs.filter(
      (e) => e.user === 'root' && String(e.stdin ?? '').includes(encoded),
    )
    expect(writes.length).toBeGreaterThan(0)
    expect(String(writes[0]?.stdin)).toContain(
      `secret\t${chief.slug}\tbot-${chief.slug}\tBANK_PASSWORD\t${encoded}`,
    )
    for (const e of guest.state.execs) expect(JSON.stringify({ ...e, stdin: null })).not.toContain(SECRET)
    const bash = guest.state.execs.find((e) => String(e.cmd).startsWith('cat '))
    expect(bash?.env).toMatchObject({ MILIBOT_SECRETS_DIR: `/run/milibot/secrets/${chief.slug}` })
    expect(JSON.stringify(bash?.env)).not.toContain('BANK_PASSWORD')

    // Typed on the screen with the real value; the unknown reference typed nothing.
    expect(guest.state.inputs).toEqual([
      { display: chief.displayNum, actions: [{ type: 'type', text: SECRET }] },
    ])

    const results = toolResults()
    expect(results[0]).toContain('The user provided BANK_PASSWORD (Bank password)')
    expect(results[0]).toContain('{{secret:BANK_PASSWORD}}')
    expect(results[1]).toContain('•••• (BANK_PASSWORD)')
    expect(results[2]).toContain('••••••')
    expect(results[3]).toContain('BANK_PASSWORD — Bank password (reference only, for a limited time)')
    expect(results[4]).toMatch(/Nothing was typed.*OTHER/)
    expect(JSON.stringify(provider.requests)).not.toContain(SECRET)

    const activity = messages().find((m) => m.kind === 'activity')?.payload
    if (activity?.type !== 'activity') throw new Error('expected activity')
    expect(activity.steps.map((s) => [s.kind, s.detail])).toContainEqual(['type', '•••• (BANK_PASSWORD)'])
    expect(messages().at(-1)?.content).toBe('Logged in. (the password was ••••••)')

    // Not in any text column of the workspace database.
    const db = runtime.store.db
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string
    }>
    for (const { name } of tables) {
      const rows = db.prepare(`SELECT * FROM "${name}"`).all()
      expect(JSON.stringify(rows), name).not.toContain(SECRET)
    }
    expect(JSON.stringify(events)).not.toContain(SECRET)
  })

  it('as_env saves a workspace variable; an existing secret answers at once; decline and stop expire', async () => {
    await boot([
      {
        toolCalls: [
          {
            name: 'request_secret',
            arguments: { name: 'GITLAB_TOKEN', label: 'GitLab token', reason: 'CI', as_env: true },
          },
        ],
      },
      {
        toolCalls: [{ name: 'request_secret', arguments: { name: 'GITLAB_TOKEN', label: 'x', reason: 'y' } }],
      },
      { toolCalls: [{ name: 'bash', arguments: { command: 'env' } }] },
      { text: 'Done.' },
      {
        toolCalls: [
          { name: 'request_secret', arguments: { name: 'CARD_PIN', label: 'PIN', reason: 'Purchase' } },
        ],
      },
      { text: "Without the PIN I can't." },
      {
        toolCalls: [
          { name: 'request_secret', arguments: { name: 'ANOTHER', label: 'Another', reason: 'Test' } },
        ],
      },
    ])
    await call('postMessage', { conversationId: chiefDm }, { content: 'set up the CI' })
    const pending = await pendingCard('secret_request')
    await call(
      'answerSecretRequest',
      { requestId: requestId(pending) },
      {
        value: 'glpat-123456789',
        remember: false,
        scope: 'all',
      },
    )
    await host.idle()
    const variables = await call<EnvSecret[]>('listEnvSecrets')
    expect(variables).toEqual([
      expect.objectContaining({
        name: 'GITLAB_TOKEN',
        exposeAsEnv: true,
        label: 'GitLab token',
        scope: 'all',
      }),
    ])
    const results = toolResults()
    expect(results[0]).toContain('environment variable $GITLAB_TOKEN')
    expect(results[1]).toContain('You already have GITLAB_TOKEN (environment variable $GITLAB_TOKEN)')
    expect(guest.state.execs.find((e) => e.cmd === 'env')?.env).toMatchObject({
      GITLAB_TOKEN: 'glpat-123456789',
    })
    expect(messages().filter((m) => m.payload?.type === 'secret_request')).toHaveLength(1)

    await call('postMessage', { conversationId: chiefDm }, { content: 'buy it' })
    await until(() => messages().filter((m) => m.payload?.type === 'secret_request').length === 2)
    const pin = messages().findLast((m) => m.payload?.type === 'secret_request') as Message
    expect((await call<Message>('declineUserRequest', { requestId: requestId(pin) })).payload).toMatchObject({
      status: 'declined',
    })
    await host.idle()
    expect(toolResults().at(-1)).toContain('declined to provide CARD_PIN')

    await call('postMessage', { conversationId: chiefDm }, { content: 'one more' })
    await until(() => messages().filter((m) => m.payload?.type === 'secret_request').length === 3)
    const other = messages().findLast((m) => m.payload?.type === 'secret_request') as Message
    await call('controlBot', { botId: chief.id }, { action: 'stop' })
    await host.idle()
    const stopped = messages().find((m) => m.id === other.id)
    expect(stopped?.payload).toMatchObject({ status: 'expired', expiredReason: 'stopped' })
    const late = await call<Message>(
      'answerSecretRequest',
      { requestId: requestId(other) },
      {
        value: 'late-value-123',
        remember: true,
        scope: 'bot',
      },
    )
    expect(late.payload).toMatchObject({ status: 'expired' })
    expect((await call<EnvSecret[]>('listEnvSecrets')).map((s) => s.name)).toEqual(['GITLAB_TOKEN'])
  })
})
