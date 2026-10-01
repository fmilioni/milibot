import type { Message } from '@milibot/shared'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { toMessageView } from '@/features/chat/lib/message-view'
import { useAppStore } from '@/features/workspace/store'

import { messageBody, type MessageBodyContext } from './MessageBody'

const ctx: MessageBodyContext = {
  bots: {},
  bot: undefined,
  mentions: [],
  showRoleChips: false,
  reduced: true,
  internal: false,
}

const message = (patch: Partial<Message>): Message => ({
  id: 'msg_1',
  conversationId: 'cnv_1',
  authorType: 'bot',
  authorBotId: 'bot_1',
  kind: 'card',
  content: 'fallback text',
  payload: null,
  createdAt: 1,
  ...patch,
})

function show(m: Message) {
  const result = messageBody(toMessageView(m), m, ctx)
  render(<>{result.node}</>)
  return result
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('messageBody', () => {
  it('shows a system event as a standalone line, its content when the payload is unknown', () => {
    const result = show(
      message({ kind: 'system_event', authorType: 'system', payload: { type: 'other' } as never }),
    )
    expect(result.standalone).toBe(true)
    expect(screen.getByText('fallback text')).toBeTruthy()
  })

  it('opens the bot panel on its routines from a routine card', () => {
    const openRightPanel = vi.spyOn(useAppStore.getState(), 'openRightPanel').mockImplementation(() => {})
    const result = show(
      message({
        payload: {
          type: 'routine_created',
          routineId: 'rtn_1',
          botId: 'bot_1',
          name: 'Daily news',
          cron: '0 9 * * *',
          nextRunAt: null,
        },
      }),
    )
    expect(result.standalone).toBe(false)
    expect(screen.getByText('Routine created: Daily news')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'View routines' }))
    expect(openRightPanel).toHaveBeenCalledWith('bot', 'routines')
  })

  it('lets a spend pause be lifted or adjusted in the settings', () => {
    const state = useAppStore.getState()
    const resumeSpend = vi.spyOn(state, 'resumeSpend').mockResolvedValue()
    const openSettings = vi.spyOn(state, 'openSettings').mockImplementation(() => {})
    const result = show(
      message({ payload: { type: 'spend_warning', spentUsd: 12, warnUsd: 5, limitUsd: 12, paused: true } }),
    )
    expect(result.standalone).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Let them work now' }))
    expect(resumeSpend).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Adjust' }))
    expect(openSettings).toHaveBeenCalledWith('costs')
  })

  it.each([
    [{ code: 'cli_login_required', params: { engine: 'codex' } }, 'Codex needs you to log in'],
    [{ code: 'cli_login_required', params: { engine: 'claude_code' } }, 'Claude Code needs you to log in'],
  ])('words a login error card with its engine and offers the login (%o)', (error, title) => {
    const openRightPanel = vi.spyOn(useAppStore.getState(), 'openRightPanel').mockImplementation(() => {})
    show(message({ payload: { type: 'error', detail: 'Not logged in', ...error } }))
    expect(screen.getByText(title)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open login terminal' }))
    expect(openRightPanel).toHaveBeenCalledWith('vm')
  })

  it('names the engine of a usage limit card', () => {
    show(
      message({
        payload: {
          type: 'error',
          code: 'cli_usage_limit',
          params: { engine: 'claude_code' },
          detail: 'limit',
        },
      }),
    )
    expect(screen.getByText("Claude Code reached your plan's usage limit")).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open login terminal' })).toBeNull()
  })
})
