import type {
  Bot,
  ConversationDebug,
  ConversationSummary,
  DebugTotals,
  LlmCallRow,
  WorkspaceEvent,
} from '@milibot/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@/features/workspace/store'

const daemon = vi.hoisted(() => ({
  call: vi.fn(),
  listeners: new Set<(workspaceId: string, event: unknown) => void>(),
}))
vi.mock('@/api/daemon', () => ({
  api: () => ({ call: daemon.call }),
  subscribeWorkspaceEvents: (listener: (workspaceId: string, event: unknown) => void) => {
    daemon.listeners.add(listener)
    return () => daemon.listeners.delete(listener)
  },
}))
vi.mock('@/features/bots/avatar/BotAvatar', () => ({ BotAvatar: () => null }))
vi.mock('./TurnDetails', () => ({
  TurnDetails: ({ row }: { row: { key: string } }) => <div data-testid="details">{row.key}</div>,
}))

import { DebugPanel } from './DebugPanel'

const CONVERSATION = 'cnv_1'
const bot = { id: 'bot_1', name: 'Theo', label: '', status: 'idle', avatar: {} } as unknown as Bot

const totals: DebugTotals = {
  calls: 1,
  errors: 0,
  costUsd: 0,
  inputTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  tokens: 0,
  cacheHitRate: null,
}

const call = (id: string, turnId: string, createdAt: number, stopReason: string): LlmCallRow => ({
  id,
  botId: bot.id,
  conversationId: CONVERSATION,
  turnId,
  purpose: 'turn',
  providerId: 'prv_1',
  providerType: 'claude_code',
  model: 'claude-sonnet-5',
  request: null,
  response: null,
  inputTokens: 10,
  cachedReadTokens: 100,
  cacheWriteTokens: 0,
  outputTokens: 5,
  reasoningTokens: 0,
  costUsd: 0.01,
  costSource: 'computed',
  contextComposition: null,
  stopReason,
  generationId: null,
  latencyMs: 1000,
  error: null,
  createdAt,
})

const debugOf = (calls: LlmCallRow[]) => ({
  debug: {
    totals,
    today: totals,
    byModel: [],
    turns: [...new Set(calls.map((c) => c.turnId as string))].map((turnId) => ({
      turnId,
      botId: bot.id,
      startedAt: 0,
      calls: 1,
      costUsd: 0.01,
      tokens: 115,
      trigger: {
        messageId: `msg_${turnId}`,
        authorType: 'user',
        authorBotId: null,
        snippet: `ask ${turnId}`,
      },
    })),
    latestComposition: [],
  } as ConversationDebug,
  calls,
})

/** What the fake daemon answers for the conversation's debug; replaced by each test step. */
let answer: () => Promise<ReturnType<typeof debugOf>>

const emit = (event: WorkspaceEvent, workspaceId = 'ws_1') =>
  act(() => {
    for (const listener of daemon.listeners) listener(workspaceId, event)
  })

const recorded = (callId: string, turnId: string, conversationId = CONVERSATION): WorkspaceEvent => ({
  type: 'llm_call.recorded',
  payload: { callId, conversationId, turnId },
})

const debugFetches = () =>
  daemon.call.mock.calls.filter(([endpoint]) => endpoint === 'getConversationDebug').length

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <DebugPanel />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  daemon.listeners.clear()
  daemon.call.mockReset()
  daemon.call.mockImplementation(async (endpoint: string) => {
    const data = await answer()
    if (endpoint === 'getConversationDebug') return data.debug
    if (endpoint === 'listLlmCalls') return data.calls
    throw new Error(`unexpected ${endpoint}`)
  })
  answer = async () => debugOf([call('llm_1', 'turn_1', 1_000, 'running')])
  useAppStore.setState({
    workspaceId: 'ws_1',
    bots: { [bot.id]: bot },
    conversations: {
      [CONVERSATION]: { id: CONVERSATION, type: 'direct', memberBotIds: [bot.id] } as ConversationSummary,
    },
    selectedConversationId: CONVERSATION,
  })
})

describe('DebugPanel', () => {
  it('shows a running turn and adds each recorded call, keeping the open turn and the list', async () => {
    show()
    const running = await screen.findByRole('button', { name: /ask turn_1/ })
    fireEvent.click(running)
    expect(screen.getByTestId('details').textContent).toBe('turn_1')
    const list = running.closest('.overflow-y-auto') as HTMLElement
    list.scrollTop = 120

    answer = async () =>
      debugOf([call('llm_1', 'turn_1', 3_000, 'success'), call('llm_2', 'turn_2', 4_000, 'running')])
    emit(recorded('llm_2', 'turn_2'))

    expect(await screen.findByRole('button', { name: /ask turn_2/ })).toBeTruthy()
    const open = screen.getByRole('button', { name: /ask turn_1/ })
    expect(open.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('details').textContent).toBe('turn_1')
    expect(open.closest('.overflow-y-auto')).toBe(list)
    expect(list.scrollTop).toBe(120)
  })

  it('keeps what it shows when a reload fails', async () => {
    show()
    fireEvent.click(await screen.findByRole('button', { name: /ask turn_1/ }))
    answer = () => Promise.reject(new Error('daemon down'))
    const before = debugFetches()
    emit(recorded('llm_1', 'turn_1'))
    await waitFor(() => expect(debugFetches()).toBeGreaterThan(before))
    await act(() => new Promise((r) => setTimeout(r, 20)))
    expect(screen.queryByText(/Couldn't|Could not/)).toBeNull()
    expect(screen.getByRole('button', { name: /ask turn_1/ }).getAttribute('aria-expanded')).toBe('true')
  })

  it('reloads while calls keep coming, and only for its own conversation', async () => {
    show()
    await screen.findByRole('button', { name: /ask turn_1/ })
    const start = debugFetches()

    emit(recorded('llm_9', 'turn_9', 'cnv_other'))
    emit(recorded('llm_1', 'turn_1'), 'ws_other')
    await act(() => new Promise((r) => setTimeout(r, 50)))
    expect(debugFetches()).toBe(start)

    // A steady stream (a running CLI turn, several bots) never starves the reload.
    for (let i = 0; i < 8; i++) {
      emit(recorded('llm_1', 'turn_1'))
      await act(() => new Promise((r) => setTimeout(r, 100)))
    }
    expect(debugFetches() - start).toBeGreaterThanOrEqual(2)
  })
})
