import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { Board, BoardDetail, TaskPayload } from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { MemorySecretStore } from '../../../src/secrets/secret-store'
import {
  bootRuntime,
  type RuntimeHarness,
  stopRuntimes,
  TEST_WORKSPACE_ID,
} from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'

const dir = useTempDir('pr-status')
let server: Server | null = null
afterEach(async () => {
  await stopRuntimes()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
})

/** A GitHub GraphQL endpoint answering every pull request with `state` (or failing with `status`). */
async function fakeGithub(answer: { state: string; status: number }, authorizations: string[]) {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString()))
    req.on('end', () => {
      authorizations.push(req.headers.authorization ?? '')
      if (answer.status !== 200) {
        res.writeHead(answer.status).end('{}')
        return
      }
      const { query } = JSON.parse(body) as { query: string }
      const data: Record<string, Record<string, unknown>> = {}
      for (const [, repo, prs] of query.matchAll(/(r\d+): repository\([^)]*\) \{ (.*?) \} \}/g))
        data[repo as string] = Object.fromEntries(
          [...(prs as string).matchAll(/(p\d+): pullRequest/g)].map(([, alias]) => [
            alias,
            { state: answer.state, isDraft: false },
          ]),
        )
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data }))
    })
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}

async function boot(githubApi: string): Promise<RuntimeHarness> {
  const secrets = new MemorySecretStore()
  await secrets.set(TEST_WORKSPACE_ID, 'github.token', 'ghp_test')
  return bootRuntime({ dir: dir(), secrets, vm: false, fallback: { text: 'ok' }, overrides: { githubApi } })
}

describe('pull request statuses kept current from GitHub', () => {
  it('moves the chat card and the board link of a pull request merged on GitHub, keeping them when GitHub fails', async () => {
    const answer = { state: 'OPEN', status: 200 }
    const authorizations: string[] = []
    const h = await boot(await fakeGithub(answer, authorizations))
    const { taskCards, pullRequestStatus, tools } = h.runtime.services
    const bot = h.store.bots.find(h.botId)!
    const url = 'https://github.com/acme/app/pull/18'
    taskCards.report(bot, h.dm, null, {
      title: 'Fix login',
      status: 'review',
      url,
      repo: 'acme/app',
      prNumber: 18,
      branch: 'bot/x',
      botId: bot.id,
    })
    const run = (name: string, args: Record<string, unknown>) =>
      tools.execute(
        { bot, conversationId: h.dm, turnId: null, signal: new AbortController().signal },
        { id: name, name, arguments: args },
      )
    await run('board_create', { title: 'Release', summary: 'Ship it.', cards: [{ title: 'Fix login' }] })
    await run('board_link', { card: 'Fix login', kind: 'pr', ref: url })
    const [board] = await h.call<Board[]>('listBoards', {}, undefined, {})
    const linkState = async () =>
      (await h.call<BoardDetail>('getBoard', { boardId: board!.id })).cards[0]?.links[0]?.state
    const chatStatus = () =>
      (h.messages(h.dm).find((m) => m.payload?.type === 'task')?.payload as TaskPayload).status

    await pullRequestStatus.refresh()
    expect(authorizations).toEqual(['Bearer ghp_test'])
    expect(chatStatus()).toBe('review')
    expect(await linkState()).toBe('review')

    answer.status = 502
    await pullRequestStatus.refresh()
    expect(chatStatus()).toBe('review')
    expect(await linkState()).toBe('review')

    answer.status = 200
    answer.state = 'MERGED'
    const events = h.events.length
    await pullRequestStatus.refresh()
    expect(chatStatus()).toBe('done')
    expect(await linkState()).toBe('done')
    const types = h.events.slice(events).map((e) => e.type)
    expect(types).toContain('message.updated')
    expect(types).toContain('board.cards.updated')

    const calls = authorizations.length
    await pullRequestStatus.refresh()
    expect(authorizations).toHaveLength(calls)
  })
})
