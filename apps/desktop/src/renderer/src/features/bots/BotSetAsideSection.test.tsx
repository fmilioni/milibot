import type { Bot, ConversationSummary, SetAsideRequest } from '@milibot/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@/features/workspace/store'

import { BotSetAsideSection } from './BotSetAsideSection'

const list = vi.fn()
const drop = vi.fn()

vi.mock('@/api/daemon', () => ({
  api: () => ({
    call: (endpoint: string, input: { params: Record<string, string>; query?: unknown }) =>
      endpoint === 'listSetAsideRequests' ? list(input) : drop(endpoint, input.params),
  }),
}))

const bot = { id: 'bot_marco', name: 'Marco' } as Bot
const theo = { id: 'bot_theo', name: 'Theo' } as Bot
const internal = {
  id: 'cnv_b',
  type: 'internal',
  memberBotIds: [theo.id, bot.id],
  title: null,
} as unknown as ConversationSummary

const request: SetAsideRequest = {
  id: 'sar_1',
  botId: bot.id,
  conversationId: internal.id,
  task: 'QA of PR #23',
  waitingOn: ['your work session "QA of PR #22"'],
  status: 'waiting',
  createdAt: Date.now() - 5 * 60_000,
  wokenAt: null,
  alertedAt: null,
}

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <BotSetAsideSection bot={bot} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  list.mockReset()
  drop.mockReset()
  drop.mockResolvedValue({ ok: true })
  useAppStore.setState({
    workspaceId: 'ws_1',
    bots: { [bot.id]: bot, [theo.id]: theo },
    conversations: { [internal.id]: internal },
  })
})

describe('BotSetAsideSection', () => {
  it('lists what the bot set aside, where and since when, and drops one', async () => {
    list.mockResolvedValue([request])
    show()
    expect(await screen.findByText('QA of PR #23')).toBeTruthy()
    expect(list).toHaveBeenCalledWith({ params: { workspaceId: 'ws_1' }, query: { botId: bot.id } })
    expect(screen.getByRole('button', { name: 'Chat with Theo' })).toBeTruthy()
    expect(screen.getByText('set aside 5 minutes ago', { exact: false })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Drop this request' }))
    await waitFor(() =>
      expect(drop).toHaveBeenCalledWith('dropSetAsideRequest', { workspaceId: 'ws_1', requestId: 'sar_1' }),
    )
  })

  it('shows nothing while nothing is set aside', async () => {
    list.mockResolvedValue([])
    const { container } = show()
    await waitFor(() => expect(list).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })
})
