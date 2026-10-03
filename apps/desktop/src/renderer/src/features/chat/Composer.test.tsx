import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@/features/workspace/store'

import { Composer } from './Composer'
import { composerDraftKey, useComposerDrafts } from './composer-drafts'

vi.mock('@/api/daemon', () => ({
  api: () => ({ call: () => Promise.reject(new Error('offline')) }),
}))

const sendMessage = vi.fn<(conversationId: string, content: string) => Promise<void>>()

const show = (conversationId: string) =>
  render(<Composer conversationId={conversationId} targetName="Theo" members={[]} />)
const box = () => screen.getByRole<HTMLTextAreaElement>('textbox')
const type = (text: string) => fireEvent.change(box(), { target: { value: text } })

beforeEach(() => {
  localStorage.clear()
  useComposerDrafts.setState({ byKey: {} })
  sendMessage.mockReset().mockResolvedValue()
  useAppStore.setState({ workspaceId: 'ws1', sendMessage })
})

describe('Composer drafts', () => {
  it('keeps the typed text when the composer leaves the screen and comes back', () => {
    const first = show('c1')
    type('half a thought')
    first.unmount()
    show('c1')
    expect(box().value).toBe('half a thought')
  })

  it('restores the draft from storage after the app restarts', () => {
    const first = show('c1')
    type('before closing')
    first.unmount()
    expect(localStorage.getItem(composerDraftKey('ws1', 'c1'))).toBe('before closing')
    useComposerDrafts.setState({ byKey: {} })
    show('c1')
    expect(box().value).toBe('before closing')
  })

  it('keeps one draft per conversation', () => {
    const view = show('c1')
    type('for c1')
    view.rerender(<Composer conversationId="c2" targetName="Theo" members={[]} />)
    expect(box().value).toBe('')
    type('for c2')
    view.rerender(<Composer conversationId="c1" targetName="Theo" members={[]} />)
    expect(box().value).toBe('for c1')
    expect(localStorage.getItem(composerDraftKey('ws1', 'c2'))).toBe('for c2')
  })

  it('keeps drafts apart across workspaces', () => {
    const first = show('c1')
    type('in ws1')
    first.unmount()
    act(() => useAppStore.setState({ workspaceId: 'ws2' }))
    show('c1')
    expect(box().value).toBe('')
  })

  it('clears the draft once the message is sent', async () => {
    show('c1')
    type('ship it')
    fireEvent.keyDown(box(), { key: 'Enter' })
    await act(async () => {})
    expect(sendMessage).toHaveBeenCalledWith('c1', 'ship it', [])
    expect(box().value).toBe('')
    expect(localStorage.getItem(composerDraftKey('ws1', 'c1'))).toBeNull()
  })

  it('keeps the draft when sending fails', async () => {
    sendMessage.mockRejectedValue(new Error('down'))
    show('c1')
    type('try again')
    fireEvent.keyDown(box(), { key: 'Enter' })
    await act(async () => {})
    expect(box().value).toBe('try again')
    expect(localStorage.getItem(composerDraftKey('ws1', 'c1'))).toBe('try again')
  })
})
