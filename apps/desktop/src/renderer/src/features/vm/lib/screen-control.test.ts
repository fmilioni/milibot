import type { Bot, ConversationSummary } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import {
  parseScreenKey,
  screenKey,
  screenNavigationChanged,
  screensToRelease,
  type ScreenViewState,
  shownScreen,
  vmPanelBot,
} from './screen-control'

function bot(id: string, status: Bot['status'] = 'idle'): Bot {
  return { id, name: id, slug: id, status } as Bot
}

function conversation(id: string, type: ConversationSummary['type'], memberBotIds: string[]) {
  return { id, type, memberBotIds } as ConversationSummary
}

const bots = { b1: bot('b1'), b2: bot('b2', 'working'), b3: bot('b3') }
const conversations = {
  dm1: conversation('dm1', 'direct', ['b1']),
  group: conversation('group', 'group', ['b1', 'b2']),
}

function view(patch: Partial<ScreenViewState> = {}): ScreenViewState {
  return {
    workspaceId: 'ws1',
    rightPanel: 'vm',
    screen: { kind: 'chat' },
    vmBotId: null,
    selectedConversationId: 'dm1',
    conversations,
    bots,
    ...patch,
  }
}

describe('vmPanelBot', () => {
  it('prefers the picked bot, then the session bot, then the conversation', () => {
    const dm = conversations.dm1
    expect(vmPanelBot({ conversation: dm, bots, vmBotId: 'b3' })?.id).toBe('b3')
    expect(vmPanelBot({ conversation: dm, bots, vmBotId: null, sessionBotId: 'b2' })?.id).toBe('b2')
    expect(vmPanelBot({ conversation: dm, bots, vmBotId: null })?.id).toBe('b1')
    expect(vmPanelBot({ conversation: conversations.group, bots, vmBotId: null })?.id).toBe('b2')
    expect(vmPanelBot({ conversation: undefined, bots, vmBotId: null })).toBeNull()
  })
})

describe('shownScreen', () => {
  it('is the VM panel bot while the panel is on screen', () => {
    expect(shownScreen(view())).toEqual({ workspaceId: 'ws1', botId: 'b1' })
    expect(shownScreen(view({ vmBotId: 'b3' }))).toEqual({ workspaceId: 'ws1', botId: 'b3' })
    expect(shownScreen(view({ screen: { kind: 'session', botId: 'b2' } }))).toEqual({
      workspaceId: 'ws1',
      botId: 'b2',
    })
  })

  it('is null when another panel or a full-window screen covers it', () => {
    expect(shownScreen(view({ rightPanel: 'bot' }))).toBeNull()
    expect(shownScreen(view({ rightPanel: null }))).toBeNull()
    expect(shownScreen(view({ screen: { kind: 'settings' } }))).toBeNull()
    expect(shownScreen(view({ screen: { kind: 'canvas' } }))).toBeNull()
    expect(shownScreen(view({ screen: { kind: 'boards' } }))).toBeNull()
    expect(shownScreen(view({ workspaceId: null }))).toBeNull()
  })
})

describe('screenNavigationChanged', () => {
  it('ignores changes that do not move the panel', () => {
    const base = view()
    expect(screenNavigationChanged({ ...base, bots: { ...bots } }, base)).toBe(false)
    expect(screenNavigationChanged(view({ selectedConversationId: 'group' }), base)).toBe(true)
    expect(screenNavigationChanged(view({ rightPanel: null }), base)).toBe(true)
    expect(screenNavigationChanged(view({ vmBotId: 'b3' }), base)).toBe(true)
    expect(screenNavigationChanged(view({ screen: { kind: 'files' } }), base)).toBe(true)
  })
})

describe('screensToRelease', () => {
  const b1 = { workspaceId: 'ws1', botId: 'b1' }
  const b2 = { workspaceId: 'ws1', botId: 'b2' }

  it('releases a taken-over screen once the panel closes or shows another bot', () => {
    const takenOver = [screenKey(b1)]
    expect(screensToRelease({ takenOver, shown: null, teaching: null })).toEqual([b1])
    expect(screensToRelease({ takenOver, shown: b2, teaching: null })).toEqual([b1])
    expect(screensToRelease({ takenOver, shown: b1, teaching: null })).toEqual([])
  })

  it('leaves the screen being taught to the recording', () => {
    expect(screensToRelease({ takenOver: [screenKey(b1)], shown: null, teaching: b1 })).toEqual([])
  })

  it('releases a screen of the workspace the window left, even the one it was teaching', () => {
    const other = { workspaceId: 'ws2', botId: 'b1' }
    expect(screensToRelease({ takenOver: [screenKey(b1)], shown: other, teaching: other })).toEqual([b1])
  })

  it('round-trips keys with colons in the bot id', () => {
    expect(parseScreenKey(screenKey({ workspaceId: 'ws_1', botId: 'bot:x' }))).toEqual({
      workspaceId: 'ws_1',
      botId: 'bot:x',
    })
  })
})
