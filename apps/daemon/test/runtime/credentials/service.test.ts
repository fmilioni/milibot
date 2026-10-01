import type { ExecResult, GuestExecRequest } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { TEMPORARY_SECRET_TTL_MS } from '../../../src/runtime/credentials/env-secrets'
import { SECRET_FILES_SCRIPT } from '../../../src/runtime/credentials/scripts/secret-files.generated'
import { CredentialService } from '../../../src/runtime/credentials/service'
import { MemorySecretStore } from '../../../src/secrets/secret-store'

const TOKEN = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'

const bots = [
  { id: 'bot_1', slug: 'ana', name: 'Ana' },
  { id: 'bot_2', slug: 'leo', name: 'Leo' },
] as never[]

function settingsBag(initial: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = { ...initial }
  return {
    values,
    getSetting: <T>(key: string, fallback: T): T => (key in values ? (values[key] as T) : fallback),
    setSetting: (key: string, value: unknown) => {
      values[key] = value
    },
  }
}

/** A VM that answers every exec with `answer` (stopped: never reached). */
function fakeVm(running: boolean, answer: (request: GuestExecRequest) => { code: number; stdout?: string }) {
  const execs: GuestExecRequest[] = []
  const vm = {
    status: () => ({ state: running ? 'running' : 'stopped' }) as never,
    subscribe: () => () => undefined,
    runningGuest: () =>
      ({
        exec: async (request: GuestExecRequest): Promise<ExecResult> => {
          execs.push(request)
          const out = answer(request)
          return {
            code: out.code,
            signal: null,
            stdout: out.stdout ?? '',
            stderr: '',
            truncated: { stdout: false, stderr: false },
            timedOut: false,
            durationMs: 1,
          }
        },
      }) as never,
  }
  return { vm, execs }
}

const githubFetch = (async (_url: string, init?: RequestInit) => {
  const auth = new Headers(init?.headers).get('authorization')
  if (auth !== `Bearer ${TOKEN}`) return new Response('{}', { status: 401 })
  return new Response(JSON.stringify({ login: 'octocat', name: 'Octocat' }), {
    headers: { 'github-authentication-token-expiration': '2026-12-01 00:00:00 UTC' },
  })
}) as typeof fetch

function service(
  options: {
    running?: boolean
    exec?: (r: GuestExecRequest) => { code: number; stdout?: string }
    now?: () => number
    secretFileOwner?: (bot: { slug: string }) => string
  } = {},
) {
  const bag = settingsBag()
  const secrets = new MemorySecretStore()
  const logs: unknown[] = []
  const { vm, execs } = fakeVm(options.running !== false, options.exec ?? (() => ({ code: 0 })))
  const svc = new CredentialService({
    workspaceId: 'ws_1',
    workspaceName: () => 'Personal',
    secrets,
    ...bag,
    now: options.now ?? (() => 1_000),
    listBots: () => bots,
    vm,
    fetch: githubFetch,
    ...(options.secretFileOwner ? { secretFileOwner: options.secretFileOwner } : {}),
    log: (...args) => logs.push(args),
  })
  return { svc, bag, secrets, execs, logs }
}

describe('credential service', () => {
  it('checks the token with GitHub, stores it in the secret store and logs every VM user in', async () => {
    const { svc, bag, secrets, execs } = service()
    const status = await svc.github.setToken(TOKEN)
    expect(status).toMatchObject({
      connected: true,
      login: 'octocat',
      tokenKind: 'fine_grained',
      expiresAt: Date.UTC(2026, 11, 1),
      sync: { ok: true, users: 3 },
    })
    expect(await secrets.get('ws_1', 'github.token')).toBe(TOKEN)
    expect(JSON.stringify(bag.values)).not.toContain(TOKEN)
    expect(execs.map((e) => e.user)).toEqual(['agent', 'bot-ana', 'bot-leo'])
    for (const e of execs) {
      expect(e.stdin).toBe(`${TOKEN}\n`)
      expect(JSON.stringify({ ...e, stdin: null })).not.toContain(TOKEN)
    }
    expect(execs[1]?.env).toMatchObject({ GIT_NAME: 'Ana (Milibot)', GIT_EMAIL: 'ana@milibot.local' })
    expect(execs[0]?.env?.GIT_NAME).toBe('')
  })

  it('refuses a token GitHub rejects', async () => {
    const { svc, secrets } = service()
    await expect(svc.github.setToken('ghp_invalidtoken123')).rejects.toThrow(/rejected/)
    expect(await secrets.get('ws_1', 'github.token')).toBeNull()
  })

  it('redacts the token and variable values from logs and failed setups', async () => {
    const { svc } = service({ exec: () => ({ code: 1 }) })
    await svc.github.setToken(TOKEN)
    await svc.createEnvSecret({ name: 'STRIPE_KEY', value: 'sk_live_abcdef123', scope: 'all' })
    expect(svc.redact({ text: `token=${TOKEN} key=sk_live_abcdef123` })).toEqual({
      text: 'token=•••••• key=••••••',
    })
    expect((await svc.github.status()).sync.ok).toBe(false)
  })

  it('does nothing in the VM while it is stopped', async () => {
    const { svc, execs } = service({ running: false })
    await svc.github.setToken(TOKEN)
    expect(execs).toEqual([])
    expect(await svc.ssh.info()).toEqual({ publicKey: null, vmRunning: false })
  })

  it('injects variables only into the bots in their scope', async () => {
    const { svc, bag } = service()
    await svc.createEnvSecret({ name: 'OPENWEATHER_KEY', value: 'weather-123456', scope: 'all' })
    const db = await svc.createEnvSecret({ name: 'DATABASE_URL', value: 'postgres://x', scope: ['bot_2'] })
    expect(db.preview).not.toContain('postgres://x')
    expect(JSON.stringify(bag.values)).not.toContain('weather-123456')

    const ana = await svc.botEnv(bots[0] as never)
    const leo = await svc.botEnv(bots[1] as never)
    expect(ana).toMatchObject({ OPENWEATHER_KEY: 'weather-123456', GIT_AUTHOR_NAME: 'Ana (Milibot)' })
    expect(ana.DATABASE_URL).toBeUndefined()
    expect(leo).toMatchObject({ OPENWEATHER_KEY: 'weather-123456', DATABASE_URL: 'postgres://x' })

    await svc.forgetBot('bot_2')
    expect((await svc.envSecrets.list()).map((s) => s.name)).toEqual(['OPENWEATHER_KEY'])
  })

  it('validates variable names', async () => {
    const { svc } = service()
    await svc.createEnvSecret({ name: 'API_KEY', value: 'x', scope: 'all' })
    await expect(svc.createEnvSecret({ name: 'API_KEY', value: 'y', scope: 'all' })).rejects.toThrow(
      /already exists/,
    )
    await expect(svc.createEnvSecret({ name: 'PATH', value: 'y', scope: 'all' })).rejects.toThrow(/reserved/)
    await expect(svc.createEnvSecret({ name: 'MILIBOT_X', value: 'y', scope: 'all' })).rejects.toThrow(
      /reserved/,
    )
  })

  it('creates the SSH key once and caches the public key', async () => {
    const { svc, bag, execs } = service({
      exec: () => ({ code: 0, stdout: 'ssh-ed25519 AAAAC3Nza milibot@personal\n' }),
    })
    expect(await svc.ssh.info()).toEqual({
      publicKey: 'ssh-ed25519 AAAAC3Nza milibot@personal',
      vmRunning: true,
    })
    expect(execs[0]).toMatchObject({ user: 'agent', env: { KEY_COMMENT: 'milibot@personal' } })
    expect(bag.values['ssh.public_key']).toBe('ssh-ed25519 AAAAC3Nza milibot@personal')
  })

  it('keeps reference-only and temporary secrets out of the environment but available by reference', async () => {
    const clock = { now: 1_000 }
    const { svc, bag, execs } = service({
      now: () => clock.now,
      secretFileOwner: (bot) => (bot.slug === 'leo' ? 'agent' : `bot-${bot.slug}`),
    })
    await svc.createEnvSecret({ name: 'API_KEY', value: 'api-key-value', scope: 'all' })
    const bank = await svc.createEnvSecret({
      name: 'BANK_PASSWORD',
      value: 'bank-secret-1',
      scope: ['bot_1'],
      exposeAsEnv: false,
      label: 'Bank password',
    })
    expect(bank).toMatchObject({ exposeAsEnv: false, label: 'Bank password' })
    svc.setTemporarySecret({ name: 'SMS_CODE', label: 'SMS code', scope: ['bot_1'], value: 'sms-998877' })

    const ana = await svc.botEnv(bots[0] as never)
    expect(ana).toMatchObject({ API_KEY: 'api-key-value', MILIBOT_SECRETS_DIR: '/run/milibot/secrets/ana' })
    expect(ana.BANK_PASSWORD).toBeUndefined()
    expect(ana.SMS_CODE).toBeUndefined()
    expect(svc.secretsFor(bots[0] as never).map((s) => [s.name, s.kind])).toEqual([
      ['API_KEY', 'env'],
      ['BANK_PASSWORD', 'private'],
      ['SMS_CODE', 'temporary'],
    ])
    expect(svc.secretsFor(bots[1] as never).map((s) => s.name)).toEqual(['API_KEY'])
    expect(svc.secretValues()).toEqual(expect.arrayContaining(['bank-secret-1', 'sms-998877']))
    expect(JSON.stringify(bag.values)).not.toMatch(/bank-secret-1|sms-998877/)

    // A temporary secret wins over a stored one with the same name.
    svc.setTemporarySecret({ name: 'BANK_PASSWORD', label: null, scope: ['bot_1'], value: 'bank-once-2' })
    expect(svc.secretsFor(bots[0] as never).find((s) => s.name === 'BANK_PASSWORD')).toMatchObject({
      kind: 'temporary',
      value: 'bank-once-2',
    })

    await svc.syncSecretFiles()
    const request = execs.at(-1) as GuestExecRequest
    expect(request).toMatchObject({
      user: 'root',
      cmd: SECRET_FILES_SCRIPT,
      env: { MILIBOT_SECRETS_ROOT: '/run/milibot/secrets' },
    })
    expect(JSON.stringify({ ...request, stdin: null })).not.toMatch(/bank|sms|api-key/)
    const lines = (request.stdin ?? '').trim().split('\n')
    expect(lines).toContain('bot\tleo\tagent\t\t')
    expect(lines).toContain(
      `secret\tana\tbot-ana\tBANK_PASSWORD\t${Buffer.from('bank-once-2').toString('base64')}`,
    )

    clock.now += TEMPORARY_SECRET_TTL_MS + 1
    expect(svc.secretsFor(bots[0] as never).map((s) => s.name)).toEqual(['API_KEY', 'BANK_PASSWORD'])
    expect(svc.secretValues()).not.toContain('sms-998877')
    svc.stop()
  })

  it('checks a web search key with one search, keeps it in the secret store and redacts it', async () => {
    const secrets = new MemorySecretStore()
    const svc = new CredentialService({
      workspaceId: 'ws_1',
      workspaceName: () => 'Personal',
      secrets,
      ...settingsBag(),
      now: () => 1_000,
      listBots: () => bots,
      vm: fakeVm(false, () => ({ code: 0 })).vm,
      webSearchEndpoints: { brave: 'https://brave.test/search', tavily: 'https://tavily.test/search' },
      fetch: (async (_url: string, init?: RequestInit) => {
        const token = new Headers(init?.headers).get('x-subscription-token')
        return new Response(JSON.stringify({ web: { results: [] } }), {
          status: token === 'BSA-good-key-1' ? 200 : 401,
        })
      }) as typeof fetch,
    })
    await svc.start()
    const { webSearch } = svc
    expect(webSearch.available()).toBe(false)
    await expect(webSearch.set('brave', 'BSA-wrong-key')).rejects.toThrow('Brave Search rejected the API key')
    expect(await webSearch.set('brave', 'BSA-good-key-1')).toEqual({
      provider: 'brave',
      keyPreview: '••••••••y-1',
      checkedAt: 1_000,
      lastError: null,
    })
    expect(webSearch.available()).toBe(true)
    expect(await secrets.get('ws_1', 'web_search.key')).toBe('BSA-good-key-1')
    expect(svc.redact({ text: 'key BSA-good-key-1' })).toEqual({ text: 'key ••••••' })
    webSearch.report('Brave Search limit reached (HTTP 429)')
    expect((await webSearch.status()).lastError).toContain('HTTP 429')
    expect(await webSearch.delete()).toEqual({
      provider: null,
      keyPreview: null,
      checkedAt: null,
      lastError: null,
    })
    expect(webSearch.available()).toBe(false)
    svc.stop()
  })
})
