import { BoardCardLinkKind, BoardCardStatus } from '@milibot/shared'

import type { ToolDefinition } from '../../llm/provider'
import { defineTools, namedRef, scalarText } from './kit'
import { PROJECT_SCOPE_ARG } from './projects'

// Kept terse: the boards skill explains the parameters.

const STR = { type: 'string' } as const
const BOOL = { type: 'boolean' } as const
const DUE = { type: 'string', description: 'YYYY-MM-DD; "" clears it.' } as const
const NAMES = { type: 'array', items: STR } as const
const NEW_CARD = {
  type: 'object',
  properties: { title: STR, summary: STR, body: STR, due: STR },
  required: ['title'],
} as const

const definitions = {
  board_create: {
    name: 'board_create',
    description: 'Create a board (kanban) for a large goal, with its first cards.',
    inputSchema: {
      type: 'object',
      properties: {
        title: STR,
        summary: STR,
        project: STR,
        due: DUE,
        cards: { type: 'array', maxItems: 60, items: NEW_CARD },
      },
      required: ['title', 'summary'],
    },
  },
  board_list: {
    name: 'board_list',
    description: 'List boards with their progress.',
    inputSchema: { type: 'object', properties: { archived: BOOL, project: PROJECT_SCOPE_ARG } },
  },
  board_get: {
    name: 'board_get',
    description: 'A board with its cards by column.',
    inputSchema: { type: 'object', properties: { board: STR }, required: ['board'] },
  },
  board_update: {
    name: 'board_update',
    description: 'Change a board; archived true hides it.',
    inputSchema: {
      type: 'object',
      properties: { board: STR, title: STR, summary: STR, due: DUE, archived: BOOL },
      required: ['board'],
    },
  },
  board_delete: {
    name: 'board_delete',
    description: 'Delete a board with all its cards.',
    inputSchema: { type: 'object', properties: { board: STR }, required: ['board'] },
  },
  board_card_write: {
    name: 'board_card_write',
    description: 'Add a card (board) or change one (card): text, status, due date, place, assignees, labels.',
    inputSchema: {
      type: 'object',
      properties: {
        card: STR,
        board: STR,
        title: STR,
        summary: STR,
        body: STR,
        status: { type: 'string', enum: [...BoardCardStatus.options] },
        due: DUE,
        before: { type: 'string', description: 'Card to place it before; "" = end of the column.' },
        assignees: NAMES,
        labels: NAMES,
      },
    },
  },
  board_card_get: {
    name: 'board_card_get',
    description: 'A card with its body, links and comments.',
    inputSchema: { type: 'object', properties: { card: STR }, required: ['card'] },
  },
  board_comment: {
    name: 'board_comment',
    description: 'Comment on a card (decisions, deviations, blockers; max 500 characters).',
    inputSchema: { type: 'object', properties: { card: STR, text: STR }, required: ['card', 'text'] },
  },
  board_link: {
    name: 'board_link',
    description: 'Link a plan, session, design, pull request, commit or URL to a card.',
    inputSchema: {
      type: 'object',
      properties: {
        card: STR,
        kind: { type: 'string', enum: [...BoardCardLinkKind.options] },
        ref: STR,
        label: STR,
        remove: BOOL,
      },
      required: ['card', 'kind', 'ref'],
    },
  },
  board_search: {
    name: 'board_search',
    description: 'Find boards and cards, past and current.',
    inputSchema: {
      type: 'object',
      properties: { query: STR, archived: BOOL, project: PROJECT_SCOPE_ARG },
      required: ['query'],
    },
  },
} satisfies Record<string, ToolDefinition>

export type BoardToolName = keyof typeof definitions

const BOARD_ID = /^(brd|bcd)_/i

export const boardTools = defineTools({
  definitions,
  describe(name, a, view) {
    switch (name) {
      case 'board_list':
        return { kind: name, detail: '' }
      case 'board_create':
        return { kind: name, detail: view.clip(scalarText(a.title), 60) }
      case 'board_get':
      case 'board_update':
      case 'board_delete':
        return { kind: name, detail: namedRef(scalarText(a.board), BOARD_ID, view) }
      case 'board_card_write':
        return {
          kind: name,
          detail: view.clip(scalarText(a.title), 60) || namedRef(scalarText(a.card), BOARD_ID, view),
        }
      case 'board_card_get':
      case 'board_comment':
      case 'board_link':
        return { kind: name, detail: namedRef(scalarText(a.card), BOARD_ID, view) }
      case 'board_search':
        return { kind: name, detail: view.clip(scalarText(a.query), 60) }
    }
  },
  labels: {
    board_create: 'created board',
    board_list: 'boards',
    board_get: 'read board',
    board_update: 'changed board',
    board_delete: 'deleted board',
    board_card_write: 'wrote card',
    board_card_get: 'read card',
    board_comment: 'commented on card',
    board_link: 'linked to card',
    board_search: 'searched boards',
  },
})

/** Board tools that only read (read-only helpers get these). */
export const BOARD_READ_TOOLS = ['board_list', 'board_get', 'board_card_get', 'board_search'] as const
