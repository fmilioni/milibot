import type { ToolExecContext, ToolResult } from '@milibot/agent'
import { solidPng } from '@milibot/agent/testing'
import type {
  Board,
  BoardCard,
  BoardCardDetail,
  BoardDetail,
  BoardPayload,
  Message,
  WorkSession,
} from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { bootRuntime, type RuntimeHarness, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'
import { until } from '../../support/wait'

let h: RuntimeHarness

const dir = useTempDir('boards')
afterEach(stopRuntimes)

async function boot() {
  h = await bootRuntime({ dir: dir(), fallback: { text: 'ok' }, host: { compaction: false } })
  await until(() => h.vm?.status().state === 'running', 8000)
}

function ctx(): ToolExecContext {
  const bot = h.store.bots.find(h.botId)
  if (!bot) throw new Error('no bot')
  return { bot, conversationId: h.dm, turnId: null, signal: new AbortController().signal }
}

const text = (result: ToolResult) => (result.content[0] as { text: string }).text

async function tool(name: string, args: Record<string, unknown>): Promise<string> {
  return text(await h.runtime.services.tools.execute(ctx(), { id: name, name, arguments: args }))
}

function boardCard(): (Message & { payload: BoardPayload }) | undefined {
  return h.store.messages
    .list(h.dm, { limit: 200 })
    .messages.find((m): m is Message & { payload: BoardPayload } => m.payload?.type === 'board')
}

const byTitle = (cards: BoardCard[], title: string) => cards.find((c) => c.title === title) as BoardCard

describe('boards', () => {
  it('plans a goal on a board, completes itself and leaves the lists when archived', async () => {
    await boot()
    const created = await tool('board_create', {
      title: 'Migrate the app to React',
      summary: 'Rewrite the jQuery front end screen by screen, keeping the API.',
      due: '2026-10-31',
      cards: [
        { title: 'Customers screen', summary: 'List and form.' },
        { title: 'Reports screen', summary: 'Charts and CSV export.' },
      ],
    })
    expect(created).toMatch(/^Created the board "Migrate the app to React" \(brd_\w+\) with 2 cards:/)
    const [board] = await h.call<Board[]>('listBoards', {}, undefined, { filter: 'active' })
    expect(board).toMatchObject({ status: 'active', counts: { todo: 2 }, dueDate: '2026-10-31' })
    expect(boardCard()?.payload).toMatchObject({ title: 'Migrate the app to React', counts: { todo: 2 } })

    expect(await tool('board_card_write', { card: 'customers', status: 'doing' })).toMatch(/Moved to Doing/)
    let detail = await h.call<BoardDetail>('getBoard', { boardId: board!.id })
    expect(byTitle(detail.cards, 'Customers screen')).toMatchObject({
      status: 'doing',
      assignees: [h.botId],
    })

    const bot = h.store.bots.find(h.botId)!
    expect(
      await tool('board_card_write', {
        card: 'reports',
        assignees: [bot.name, 'user'],
        labels: ['UI', 'Charts'],
      }),
    ).toMatch(/Updated the card "Reports screen"/)
    detail = await h.call<BoardDetail>('getBoard', { boardId: board!.id })
    expect(detail.labels.map((l) => [l.name, l.color])).toEqual([
      ['UI', 'red'],
      ['Charts', 'orange'],
    ])
    expect(byTitle(detail.cards, 'Reports screen')).toMatchObject({
      assignees: [h.botId, 'user'],
      labelIds: detail.labels.map((l) => l.id),
    })
    await tool('board_card_write', { card: 'customers', labels: ['ui'] })
    expect(await tool('board_get', { board: 'Migrate' })).toMatch(
      /Customers screen .* · assigned to \S+ · labels: UI/,
    )
    expect(await tool('board_card_write', { card: 'reports', assignees: ['nobody'] })).toMatch(
      /there is no bot "nobody"/,
    )
    await h.call('deleteBoardLabel', { boardId: board!.id, labelId: detail.labels[0]!.id })
    detail = await h.call<BoardDetail>('getBoard', { boardId: board!.id })
    expect(byTitle(detail.cards, 'Reports screen').labelIds).toEqual([detail.labels[0]!.id])
    expect(byTitle(detail.cards, 'Customers screen').labelIds).toEqual([])

    expect(await tool('board_comment', { card: 'customers', text: 'x'.repeat(600) })).toMatch(/under 500/)
    await tool('board_comment', { card: 'customers', text: 'Decision: masks moved to src/lib/masks.ts.' })
    const read = await tool('board_card_get', { card: 'Customers screen' })
    expect(read).toContain('Decision: masks moved')
    expect(read).toMatch(/Doing · board "Migrate the app to React"/)

    await tool('board_card_write', { card: 'customers', status: 'done' })
    expect(await tool('board_card_write', { card: 'reports', status: 'dropped' })).toMatch(
      /Every card of "Migrate the app to React" is now done or dropped/,
    )
    detail = await h.call<BoardDetail>('getBoard', { boardId: board!.id })
    expect(detail).toMatchObject({ status: 'done', counts: { done: 1, dropped: 1 } })
    expect(detail.completedAt).not.toBeNull()
    expect(boardCard()?.payload).toMatchObject({ status: 'done' })

    await tool('board_card_write', { board: 'Migrate the app to React', title: 'Remove jQuery' })
    expect((await h.call<BoardDetail>('getBoard', { boardId: board!.id })).status).toBe('active')

    await tool('board_update', { board: 'Migrate', archived: true })
    expect(await tool('board_list', {})).toMatch(/There are no active boards/)
    expect(await tool('board_list', { archived: true })).toMatch(
      /Migrate the app to React \[active, archived/,
    )
    expect(await tool('board_card_write', { card: 'Remove jQuery', status: 'doing' })).toMatch(
      /There is no card/,
    )
    expect(await tool('board_card_write', { board: 'Migrate the app to React', title: 'More' })).toMatch(
      /archived; unarchive it with board_update first/,
    )
    expect(await tool('board_search', { query: 'jquery screen' })).toMatch(/No board or card matches/)
    expect(await tool('board_search', { query: 'jquery screen', archived: true })).toMatch(
      /Migrate the app to React/,
    )
    expect(boardCard()?.payload).toMatchObject({ archived: true })

    await h.call('deleteBoard', { boardId: board!.id })
    expect(await h.call<Board[]>('listBoards', {}, undefined, {})).toEqual([])
    expect(boardCard()?.payload).toMatchObject({ removed: true })
  })

  it('links plans, sessions and pull requests to the card and brings the card into the session', async () => {
    await boot()
    await tool('board_create', {
      title: 'Finance tool',
      summary: 'MVP of a personal finance tool.',
      cards: [{ title: 'Import bank statements', body: 'OFX and CSV.' }],
    })
    await tool('board_comment', { card: 'Import bank statements', text: 'Use the parser the user picked.' })
    expect(
      await tool('plan_write', {
        title: 'Statement import',
        summary: 'Parses OFX and CSV files into transactions.',
        body: 'The plan.',
        steps: [{ title: 'Parser' }],
        card: 'import bank',
      }),
    ).toMatch(/saved as a draft/)
    const [board] = await h.call<Board[]>('listBoards', {}, undefined, {})
    let card = (await h.call<BoardDetail>('getBoard', { boardId: board!.id })).cards[0] as BoardCard
    expect(card.links).toMatchObject([{ kind: 'plan', label: 'Statement import' }])
    expect(card.status).toBe('todo')

    expect(
      await tool('session_start', { title: 'Import statements', goal: 'Do it.', card: card.id }),
    ).toMatch(/Work session "Import statements" started/)
    const [session] = await h.call<WorkSession[]>('listWorkSessions', {}, undefined, {})
    card = (await h.call<BoardDetail>('getBoard', { boardId: board!.id })).cards[0] as BoardCard
    expect(card).toMatchObject({ status: 'doing', assignees: [h.botId] })
    expect(card.links.map((l) => l.kind)).toEqual(['plan', 'session'])
    const brief = h.store.messages
      .list(session!.conversationId, { limit: 20 })
      .messages.find((m) => m.payload?.type === 'session_brief')
    expect(brief?.payload).toMatchObject({ cardId: card.id })
    expect(brief?.content).toContain('Board card: "Import bank statements"')
    expect(brief?.content).toContain('Use the parser the user picked.')

    h.runtime.services.boards.linkPullRequest(session!.conversationId, {
      type: 'task',
      title: 'feat: import statements',
      status: 'open',
      url: 'https://github.com/acme/fin/pull/7',
      repo: 'acme/fin',
      prNumber: 7,
      branch: 'bot/x',
      botId: h.botId,
    })
    const detail = await h.call<BoardCardDetail>('getBoardCard', { boardId: board!.id, cardId: card.id })
    expect(detail.links.find((l) => l.kind === 'pr')).toMatchObject({
      label: '#7 feat: import statements',
      url: 'https://github.com/acme/fin/pull/7',
      state: 'open',
    })

    await tool('board_card_write', { board: board!.id, title: 'Export reports' })
    const other = (await h.call<BoardDetail>('getBoard', { boardId: board!.id })).cards.find(
      (c) => c.title === 'Export reports',
    ) as BoardCard
    await tool('board_link', { card: other.id, kind: 'pr', ref: 'https://github.com/Acme/fin/pull/7/files' })
    const prLinks = async () =>
      (await h.call<BoardDetail>('getBoard', { boardId: board!.id })).cards.map(
        (c) => c.links.find((l) => l.kind === 'pr')?.state,
      )
    expect(h.runtime.services.boards.trackedPullRequests()).toHaveLength(2)

    // Merged from a conversation outside the session (the PM's DM): every card linking the PR follows.
    h.runtime.services.boards.linkPullRequest(h.dm, {
      type: 'task',
      title: 'feat: import statements',
      status: 'done',
      url: 'https://github.com/acme/fin/pull/7',
      repo: 'acme/fin',
      prNumber: 7,
      branch: 'bot/x',
      botId: h.botId,
    })
    expect(await prLinks()).toEqual(['done', 'done'])
    expect(h.runtime.services.boards.trackedPullRequests()).toEqual([])

    h.runtime.services.boards.applyPullRequestStates(
      new Map([['https://github.com/acme/fin/pull/7', 'review']]),
    )
    expect(await prLinks()).toEqual(['done', 'done'])
  })

  it('updates pull request links from statuses read on GitHub, leaving the others as they were', async () => {
    await boot()
    await tool('board_create', {
      title: 'Release',
      summary: 'Ship it.',
      cards: [{ title: 'Fix login' }, { title: 'Fix logout' }],
    })
    const [board] = await h.call<Board[]>('listBoards', {}, undefined, {})
    await tool('board_link', { card: 'Fix login', kind: 'pr', ref: 'https://github.com/acme/app/pull/18' })
    await tool('board_link', { card: 'Fix logout', kind: 'pr', ref: 'https://github.com/acme/app/pull/19' })
    const cardEvents = () => h.events.filter((e) => e.type === 'board.cards.updated').length
    const before = cardEvents()

    h.runtime.services.boards.applyPullRequestStates(
      new Map([['https://github.com/acme/app/pull/18', 'failed']]),
    )
    const cards = (await h.call<BoardDetail>('getBoard', { boardId: board!.id })).cards
    expect(byTitle(cards, 'Fix login').links[0]?.state).toBe('failed')
    expect(byTitle(cards, 'Fix logout').links[0]?.state).toBeNull()
    expect(cardEvents()).toBe(before + 1)

    h.runtime.services.boards.applyPullRequestStates(
      new Map([['https://github.com/acme/app/pull/18', 'failed']]),
    )
    expect(cardEvents()).toBe(before + 1)
  })

  it('keeps card images as blobs and shows them to bots as paths in the VM', async () => {
    await boot()
    h.guest.state.files.set('/workspace/shots/old.png', solidPng(4, 3, [10, 20, 30]))
    await tool('board_create', { title: 'Redesign', summary: 'New look.' })
    expect(
      await tool('board_card_write', {
        board: 'Redesign',
        title: 'Home',
        body: 'Today:\n\n![old home](/workspace/shots/old.png)\n\n![missing](/workspace/nope.png)',
      }),
    ).toMatch(/The image \/workspace\/nope\.png was not added/)
    const [board] = await h.call<Board[]>('listBoards', {}, undefined, {})
    const card = (await h.call<BoardDetail>('getBoard', { boardId: board!.id })).cards[0] as BoardCard
    expect(card.imageCount).toBe(1)
    const detail = await h.call<BoardCardDetail>('getBoardCard', { boardId: board!.id, cardId: card.id })
    expect(detail.body).toMatch(/!\[old home\]\(asset:[0-9a-f]{64}\)/)

    const read = await tool('board_card_get', { card: 'Home' })
    const path = /!\[old home\]\((\/workspace\/boards\/redesign-\w+\/[0-9a-f]{8}-old-home\.png)\)/.exec(
      read,
    )?.[1]
    expect(path).toBeDefined()
    expect(h.guest.state.files.has(path as string)).toBe(true)
    const sha = /asset:([0-9a-f]{64})/.exec(detail.body)?.[1]
    expect(h.runtime.services.boards.referencedBlobs()).toEqual([sha])
  })

  it('moves cards for the user and uploads images in chunks', async () => {
    await boot()
    const board = await h.call<BoardDetail>('createBoard', {}, { title: 'Launch', summary: 'Ship v2.' })
    for (const title of ['A', 'B', 'C']) await h.call('createBoardCard', { boardId: board.id }, { title })
    const cards = (await h.call<BoardDetail>('getBoard', { boardId: board.id })).cards
    const moved = await h.call<BoardCard[]>(
      'moveBoardCard',
      { boardId: board.id, cardId: byTitle(cards, 'C').id },
      { status: 'todo', index: 0 },
    )
    expect(
      moved
        .filter((c) => c.status === 'todo')
        .sort((a, b) => a.position - b.position)
        .map((c) => c.title),
    ).toEqual(['C', 'A', 'B'])
    expect(h.events.some((e) => e.type === 'board.cards.updated')).toBe(true)

    const label = await h.call<{ id: string; color: string }>(
      'createBoardLabel',
      { boardId: board.id },
      { name: 'Bug', color: 'red' },
    )
    const updated = await h.call<BoardCard>(
      'updateBoardCard',
      { boardId: board.id, cardId: byTitle(cards, 'A').id },
      { assignees: ['user', h.botId], labelIds: [label.id] },
    )
    expect(updated).toMatchObject({ assignees: ['user', h.botId], labelIds: [label.id] })
    await expect(h.call('createBoardLabel', { boardId: board.id }, { name: 'bug' })).rejects.toMatchObject({
      code: 'conflict',
    })
    await expect(
      h.call(
        'updateBoardCard',
        { boardId: board.id, cardId: byTitle(cards, 'A').id },
        { assignees: ['bot_x'] },
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' })
    expect(
      await h.call('updateBoardLabel', { boardId: board.id, labelId: label.id }, { color: 'teal' }),
    ).toMatchObject({ name: 'Bug', color: 'teal' })

    const png = Buffer.from(solidPng(2, 2, [1, 2, 3]))
    const upload = await h.call<{ id: string }>(
      'createBoardImage',
      { boardId: board.id },
      { name: 'shot.png', size: png.length, mimeType: 'image/png' },
    )
    await h.call(
      'uploadBoardImageChunk',
      { boardId: board.id, uploadId: upload.id },
      { offset: 0, data: png.toString('base64') },
    )
    const image = await h.call<{ markdown: string; path: string }>('completeBoardImage', {
      boardId: board.id,
      uploadId: upload.id,
    })
    expect(image.markdown).toMatch(/^!\[shot\.png\]\(asset:[0-9a-f]{64}\)$/)
    await until(() => h.guest.state.files.has(image.path), 4000)
  })
})
