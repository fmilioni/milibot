import type { ConversationSummary, WorkSession } from '@milibot/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ handler: vi.fn() }))
vi.mock('@/api/daemon', () => ({
  api: () => ({ call: calls.handler }),
  followWorkspaceEvents: vi.fn(),
}))

import { createAppStore } from './index'

const conversation = (id: string, type: ConversationSummary['type']): ConversationSummary =>
  ({ id, type, memberBotIds: ['b1'], sidebar: { hidden: false, unreadCount: 0 } }) as ConversationSummary

const workSession = {
  id: 'wks_1',
  conversationId: 'cnv_s',
  originConversationId: 'dm',
  botId: 'b1',
} as WorkSession

function store() {
  const s = createAppStore()
  s.setState({
    workspaceId: 'ws1',
    conversations: { dm: conversation('dm', 'direct'), cnv_s: conversation('cnv_s', 'session') },
    selectedConversationId: 'dm',
  })
  return s
}

beforeEach(() => {
  calls.handler.mockReset()
  calls.handler.mockImplementation(async (name: string) => {
    if (name === 'getWorkSession') return workSession
    if (name === 'listMessages') return { messages: [], hasMore: false }
    return undefined
  })
})

describe('app store navigation', () => {
  it('shows one screen at a time', () => {
    const s = store()
    s.getState().openSettings('skills')
    expect(s.getState().screen).toEqual({ kind: 'settings', section: 'skills' })
    s.getState().openBoards('brd_1')
    expect(s.getState().screen).toEqual({ kind: 'boards', boardId: 'brd_1' })
    s.getState().selectConversation('dm')
    expect(s.getState().screen).toEqual({ kind: 'chat' })
  })

  it('restores the right panel after the session screen', async () => {
    const s = store()
    s.getState().openRightPanel('bot')
    await s.getState().openWorkSession('wks_1')
    expect(s.getState().screen).toMatchObject({ kind: 'session', sessionId: 'wks_1', restorePanel: 'bot' })
    expect(s.getState().rightPanel).toBeNull()
    s.getState().closeWorkSession()
    expect(s.getState().screen).toEqual({ kind: 'chat' })
    expect(s.getState().rightPanel).toBe('bot')
    expect(s.getState().selectedConversationId).toBe('dm')
  })

  it('closes a canvas opened from the designs screen back to it', async () => {
    const s = store()
    s.getState().openDesigns()
    await s.getState().openCanvas('dsg_1', null)
    expect(s.getState().screen).toMatchObject({
      kind: 'canvas',
      designId: 'dsg_1',
      backNav: { kind: 'designs' },
    })
    s.getState().toggleCanvasSidebar()
    await s.getState().openCanvas('dsg_2', null)
    expect(s.getState().screen).toMatchObject({ kind: 'canvas', designId: 'dsg_2', sidebar: true })
    s.getState().closeCanvas()
    expect(s.getState().screen).toEqual({ kind: 'designs' })
  })

  it("returns a session conversation's canvas to its session", async () => {
    const s = store()
    await s.getState().openWorkSession('wks_1')
    await s.getState().openCanvas('dsg_1', 'cnv_s')
    expect(s.getState().screen).toMatchObject({
      kind: 'canvas',
      back: { sessionId: 'wks_1', conversationId: 'dm' },
    })
    s.getState().closeCanvas()
    await vi.waitFor(() => expect(s.getState().screen).toMatchObject({ kind: 'session', sessionId: 'wks_1' }))
  })

  it('leaves the canvas for the chat when a right panel opens', async () => {
    const s = store()
    await s.getState().openCanvas('dsg_1', null)
    s.getState().showBotScreen('b1')
    expect(s.getState().screen).toEqual({ kind: 'chat' })
    expect(s.getState().rightPanel).toBe('vm')
    expect(s.getState().vmBotId).toBe('b1')
  })

  it('keeps the settings open when switching workspaces there', async () => {
    const s = store()
    Object.assign(globalThis, { window: { milibot: { setWindowWorkspace: vi.fn() } } })
    s.getState().openSettings('workspaces')
    calls.handler.mockRejectedValue(new Error('offline'))
    await s
      .getState()
      .switchWorkspace('ws2')
      .catch(() => undefined)
    expect(s.getState().screen).toEqual({ kind: 'settings', section: 'workspaces' })
  })
})
