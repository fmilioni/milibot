import { applyCardMove, type Board, type BoardCardStatus, columnCards } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import {
  activeFilterCount,
  applyFormat,
  avatarStack,
  boardsIn,
  doingLoad,
  dropPlace,
  filterCards,
  insertAtCaret,
  liveBotOf,
  NO_FILTERS,
  prChip,
} from './boards'

const card = (id: string, status: BoardCardStatus, position: number) => ({ id, status, position })

describe('boards view', () => {
  const cards = [card('a', 'todo', 0), card('b', 'todo', 1), card('c', 'todo', 2), card('d', 'doing', 0)]

  it('drops on a card at its place, on a column at its end', () => {
    expect(dropPlace(cards, 'b')).toEqual({ status: 'todo', index: 1 })
    expect(dropPlace(cards, 'column:doing')).toEqual({ status: 'doing', index: 1 })
    expect(dropPlace(cards, 'column:done')).toEqual({ status: 'done', index: 0 })
    expect(dropPlace(cards, 'nope')).toBeNull()
  })

  it('moves a card down its column like the list the user sees', () => {
    const place = dropPlace(cards, 'c')!
    const moved = applyCardMove(cards, 'a', place.status, place.index)
    expect(columnCards(moved, 'todo').map((c) => c.id)).toEqual(['b', 'c', 'a'])
  })

  it('splits boards into active, done and archived', () => {
    const board = (id: string, status: 'active' | 'done', archived: boolean) =>
      ({
        id,
        status,
        archivedAt: archived ? 1 : null,
        counts: { todo: 0, doing: 0, done: 0, dropped: 0 },
      }) as Board
    const boards = [board('a', 'active', false), board('b', 'done', false), board('c', 'done', true)]
    expect(boardsIn(boards, 'active').map((b) => b.id)).toEqual(['a'])
    expect(boardsIn(boards, 'done').map((b) => b.id)).toEqual(['b'])
    expect(boardsIn(boards, 'archived').map((b) => b.id)).toEqual(['c'])
  })

  it('puts an image on its own line at the caret', () => {
    expect(insertAtCaret('ab', 1, '![x](asset:1)')).toEqual({ text: 'a\n![x](asset:1)\nb', caret: 16 })
    expect(insertAtCaret('', 0, 'img')).toEqual({ text: 'img', caret: 3 })
    expect(insertAtCaret('line\n', 5, 'img')).toEqual({ text: 'line\nimg', caret: 8 })
  })
})

describe('card filters', () => {
  const labels = [
    { id: 'l1', boardId: 'b', name: 'Front', color: 'blue' as const },
    { id: 'l2', boardId: 'b', name: 'Priority: high', color: 'yellow' as const },
  ]
  const cards = [
    { id: 'a', title: 'Avatar do bot', summary: 'Contorno escuro', labelIds: ['l1'], assignees: ['bot_x'] },
    { id: 'b', title: 'Modal do card', summary: '', labelIds: ['l2'], assignees: ['user'] },
    { id: 'c', title: 'MCP e OAuth', summary: 'Servidores', labelIds: [], assignees: [] },
  ]
  const ids = (list: { id: string }[]) => list.map((c) => c.id)

  it('keeps every card without filters', () => {
    expect(ids(filterCards(cards, NO_FILTERS, labels))).toEqual(['a', 'b', 'c'])
    expect(activeFilterCount(NO_FILTERS)).toBe(0)
  })

  it('matches every word in the title, summary or label names, ignoring case', () => {
    expect(ids(filterCards(cards, { ...NO_FILTERS, text: 'HIGH' }, labels))).toEqual(['b'])
    expect(ids(filterCards(cards, { ...NO_FILTERS, text: 'escuro avatar' }, labels))).toEqual(['a'])
    expect(ids(filterCards(cards, { ...NO_FILTERS, text: 'front oauth' }, labels))).toEqual([])
  })

  it('narrows by assignee, label and the user, all at once', () => {
    const filters = { text: ' ', assignees: ['bot_x', 'user'], labels: ['l2'], mine: true }
    expect(ids(filterCards(cards, filters, labels))).toEqual(['b'])
    expect(activeFilterCount(filters)).toBe(3)
    expect(ids(filterCards(cards, { ...NO_FILTERS, assignees: ['bot_x'] }, labels))).toEqual(['a'])
  })
})

describe('card tile parts', () => {
  it('reads the pull request number and a known state', () => {
    expect(prChip({ label: '#23 feat: x', url: null, ref: 'u', state: 'open' })).toEqual({
      number: '#23',
      state: 'open',
    })
    expect(
      prChip({ label: 'fix', url: 'https://github.com/a/b/pull/7/files', ref: 'u', state: 'weird' }),
    ).toEqual({ number: '#7', state: null })
    expect(prChip({ label: 'fix', url: null, ref: 'https://x', state: null })).toEqual({
      number: null,
      state: null,
    })
  })

  it('shows three avatars and counts the rest', () => {
    expect(avatarStack(['a', 'b', 'c'])).toEqual({ shown: ['a', 'b', 'c'], extra: 0 })
    expect(avatarStack(['a', 'b', 'c', 'd', 'e'])).toEqual({ shown: ['a', 'b', 'c'], extra: 2 })
  })

  it('warns from the Doing limit on', () => {
    expect(doingLoad(2, null)).toEqual({ text: '2', over: false })
    expect(doingLoad(2, 3)).toEqual({ text: '2 / 3', over: false })
    expect(doingLoad(3, 3)).toEqual({ text: '3 / 3', over: true })
    expect(doingLoad(4, 3).over).toBe(true)
  })

  it('finds the bot working on a card through a running session or an executing plan', () => {
    const link = (kind: 'session' | 'plan', ref: string) => ({
      id: ref,
      kind,
      ref,
      label: '',
      url: null,
      state: null,
      createdAt: 0,
    })
    const sessions = {
      s1: { status: 'idle', botId: 'bot_a' },
      s2: { status: 'running', botId: 'bot_b' },
      s3: { status: 'preparing', botId: 'bot_c' },
    }
    const plans = [{ id: 'p1', status: 'executing', botId: 'bot_d' }]
    expect(liveBotOf({ links: [link('session', 's1')] }, sessions, plans)).toBeNull()
    expect(liveBotOf({ links: [link('session', 's1'), link('session', 's2')] }, sessions, plans)).toBe(
      'bot_b',
    )
    expect(liveBotOf({ links: [link('session', 's3')] }, sessions, plans)).toBe('bot_c')
    expect(liveBotOf({ links: [link('plan', 'p1')] }, sessions, plans)).toBe('bot_d')
    expect(liveBotOf({ links: [link('plan', 'p2'), link('session', 'gone')] }, sessions, plans)).toBeNull()
  })
})

describe('applyFormat', () => {
  it('wraps the selection, or a placeholder, in inline marks and keeps it selected', () => {
    expect(applyFormat('make it bold', 8, 12, 'bold')).toEqual({
      text: 'make it **bold**',
      start: 10,
      end: 14,
    })
    expect(applyFormat('a b', 2, 2, 'italic', 'word')).toEqual({ text: 'a _word_b', start: 3, end: 7 })
    expect(applyFormat('run x', 4, 5, 'code').text).toBe('run `x`')
    expect(applyFormat('a\nb', 0, 3, 'code').text).toBe('```\na\nb\n```')
    expect(applyFormat('see docs', 4, 8, 'link').text).toBe('see [docs](https://)')
  })

  it('prefixes every selected line for headings and lists', () => {
    expect(applyFormat('one\ntwo\nthree', 5, 9, 'list').text).toBe('one\n1. two\n2. three')
    expect(applyFormat('# Old\nbody', 2, 2, 'heading').text).toBe('## Old\nbody')
  })
})
