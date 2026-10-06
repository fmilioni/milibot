import { ApiError, type RefInfo } from '@milibot/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { applyCacheUpdates, workspaceCacheUpdates } from '@/api/cache-updates'
import { useAppStore } from '@/features/workspace/store'
import { LinkifiedText } from '@/ui/LinkifiedText'
import { Markdown } from '@/ui/Markdown'

import { RefLinkProvider } from './RefLinkProvider'

const daemon = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/api/daemon', () => ({ api: () => ({ call: daemon.call }) }))

const ULID = '01m41qvydqnjxef4ax623he0my'
const card = `bcd_${ULID}`
const board = `brd_${ULID}`
const plan = `plan_${ULID}`
const gone = `dsg_${ULID}`
const known: Record<string, RefInfo> = {
  [card]: { id: card, kind: 'card', name: 'Clickable ids', boardId: board },
  [board]: { id: board, kind: 'board', name: 'Release 0.4' },
  [plan]: { id: plan, kind: 'plan', name: 'Links plan' },
}

let client: QueryClient

function show(node: ReactNode) {
  return render(
    <QueryClientProvider client={client}>
      <RefLinkProvider>{node}</RefLinkProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  daemon.call.mockReset()
  daemon.call.mockImplementation((endpoint: string, input: { body: { ids: string[] } }) => {
    if (endpoint !== 'resolveRefs') throw new Error(`unexpected ${endpoint}`)
    return Promise.resolve({ refs: input.body.ids.flatMap((id) => known[id] ?? []) })
  })
  useAppStore.setState({ workspaceId: 'ws_1' })
})

describe('ids in text', () => {
  it('shows the names of every id in one call to the daemon', async () => {
    show(
      <>
        <LinkifiedText text={`Card ${card} on ${board}`} />
        <Markdown text={`Plan ${plan} and card ${card}`} />
      </>,
    )
    expect(await screen.findAllByRole('link', { name: 'Clickable ids' })).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'Release 0.4' }).getAttribute('title')).toBe(board)
    expect(screen.getByRole('link', { name: 'Links plan' })).toBeTruthy()
    expect(daemon.call).toHaveBeenCalledTimes(1)
    expect(daemon.call.mock.calls[0]?.[1].body.ids.sort()).toEqual([board, card, plan].sort())
  })

  it('keeps an id that no longer exists as text', async () => {
    show(<LinkifiedText text={`Design ${gone} was deleted`} />)
    await waitFor(() => expect(daemon.call).toHaveBeenCalled())
    expect(screen.getByText(gone).tagName).toBe('SPAN')
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('opens a card on its board', async () => {
    show(<LinkifiedText text={card} />)
    fireEvent.click(await screen.findByRole('link', { name: 'Clickable ids' }))
    expect(useAppStore.getState().screen).toEqual({ kind: 'boards', boardId: board, cardId: card })
  })

  it('follows renames and deletions from events', async () => {
    show(<LinkifiedText text={`${board} ${plan}`} />)
    await screen.findByRole('link', { name: 'Release 0.4' })
    applyCacheUpdates(
      client,
      workspaceCacheUpdates('ws_1', {
        type: 'board.updated',
        payload: { board: { id: board, title: 'Release 0.5' } },
      } as never),
    )
    expect(await screen.findByRole('link', { name: 'Release 0.5' })).toBeTruthy()
    applyCacheUpdates(
      client,
      workspaceCacheUpdates('ws_1', { type: 'plan.deleted', payload: { planId: plan } } as never),
    )
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Links plan' })).toBeNull())
    expect(screen.getByText(plan)).toBeTruthy()
  })
})

describe('/workspace paths in text', () => {
  it('tells a symlink to outside /workspace apart from other failures', async () => {
    daemon.call.mockRejectedValue(
      new ApiError('validation_failed', 'outside', 400, { code: 'OUTSIDE_WORKSPACE' }),
    )
    show(<LinkifiedText text="see /workspace/link-out.txt" />)
    fireEvent.click(screen.getByRole('link', { name: '/workspace/link-out.txt' }))
    await waitFor(() => expect(useAppStore.getState().toast).toBe('fileOutsideWorkspace'))
  })
})
