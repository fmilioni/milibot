import { describe, expect, it } from 'vitest'

import { canvasScreenFor, enterScreen, type Screen, visibleConversationId } from './navigation'

const session = {
  kind: 'session',
  sessionId: 'wks_1',
  conversationId: 'cnv_s',
  originConversationId: 'cnv_dm',
  botId: 'bot_1',
} as const

describe('enterScreen', () => {
  it('starts a session on its own tabs and keeps the panel open before it', () => {
    const entered = enterScreen({ screen: { kind: 'chat' }, rightPanel: 'vm' }, session)
    expect(entered).toEqual({ screen: { ...session, restorePanel: 'vm' }, rightPanel: null })
  })

  it("keeps the first session's panel when moving to another session", () => {
    const inSession: Screen = { ...session, restorePanel: 'bot' }
    const next = enterScreen({ screen: inSession, rightPanel: 'debug' }, { ...session, sessionId: 'wks_2' })
    expect(next).toEqual({
      screen: { ...session, sessionId: 'wks_2', restorePanel: 'bot' },
      rightPanel: null,
    })
  })

  it('brings the panel back when leaving the session', () => {
    const inSession: Screen = { ...session, restorePanel: 'vm' }
    expect(enterScreen({ screen: inSession, rightPanel: 'debug' }, { kind: 'chat' })).toEqual({
      screen: { kind: 'chat' },
      rightPanel: 'vm',
    })
    expect(
      enterScreen({ screen: { ...session, restorePanel: null }, rightPanel: 'vm' }, { kind: 'files' }),
    ).toEqual({ screen: { kind: 'files' }, rightPanel: null })
  })

  it('leaves the right panel alone between other screens', () => {
    expect(enterScreen({ screen: { kind: 'chat' }, rightPanel: 'bot' }, { kind: 'designs' })).toEqual({
      screen: { kind: 'designs' },
      rightPanel: 'bot',
    })
  })
})

describe('canvasScreenFor', () => {
  it('goes back to the sidebar screen it was opened from, even after switching designs', () => {
    const fromDesigns = canvasScreenFor(
      'dsg_1',
      { screen: { kind: 'designs' }, selectedConversationId: 'c1' },
      'direct',
    )
    expect(fromDesigns).toEqual({
      kind: 'canvas',
      designId: 'dsg_1',
      sidebar: false,
      backNav: { kind: 'designs' },
    })
    const switched = canvasScreenFor(
      'dsg_2',
      { screen: { ...fromDesigns, sidebar: true }, selectedConversationId: 'c1' },
      'direct',
    )
    expect(switched).toEqual({
      kind: 'canvas',
      designId: 'dsg_2',
      sidebar: true,
      backNav: { kind: 'designs' },
    })
  })

  it("brings a session conversation's canvas back to the session or the chat selected before", () => {
    const fromSession = canvasScreenFor(
      'dsg_1',
      { screen: { ...session, restorePanel: null }, selectedConversationId: 'cnv_dm' },
      'session',
    )
    expect(fromSession.back).toEqual({ sessionId: 'wks_1', conversationId: 'cnv_dm' })
    const fromChat = canvasScreenFor(
      'dsg_1',
      { screen: { kind: 'chat' }, selectedConversationId: 'cnv_dm' },
      'session',
    )
    expect(fromChat.back).toEqual({ sessionId: null, conversationId: 'cnv_dm' })
    const kept = canvasScreenFor('dsg_2', { screen: fromSession, selectedConversationId: 'cnv_s' }, 'session')
    expect(kept.back).toBe(fromSession.back)
  })

  it('has no way back for other conversations (closing shows the chat)', () => {
    const canvas = canvasScreenFor(
      'dsg_1',
      { screen: { kind: 'chat' }, selectedConversationId: 'c1' },
      'direct',
    )
    expect(canvas).toEqual({ kind: 'canvas', designId: 'dsg_1', sidebar: false })
  })
})

describe('visibleConversationId', () => {
  it('is the chat next to the screen, or none', () => {
    const at = (screen: Screen) => visibleConversationId({ screen, selectedConversationId: 'c1' })
    expect(at({ kind: 'chat' })).toBe('c1')
    expect(at({ kind: 'canvas', designId: 'd', sidebar: false })).toBe('c1')
    expect(at({ ...session, restorePanel: null })).toBe('cnv_s')
    expect(at({ kind: 'settings', section: 'general' })).toBeNull()
    expect(at({ kind: 'boards', boardId: null })).toBeNull()
  })
})
