import type { ToolExecContext, ToolResult } from '@milibot/agent'
import { makeBot } from '@milibot/agent/testing'
import { describe, expect, it } from 'vitest'

import { BrowserService } from '../../../src/runtime/browser/service'
import { BrowserTools, normalizeUrl } from '../../../src/runtime/browser/tools'
import type { VmController } from '../../../src/runtime/vm/controller'
import { fakeChrome } from '../../support/fake-chrome'

describe('normalizeUrl', () => {
  it('adds https to bare hosts and keeps schemes', () => {
    expect(normalizeUrl('mail.google.com')).toBe('https://mail.google.com')
    expect(normalizeUrl('localhost:3000')).toBe('http://localhost:3000')
    expect(normalizeUrl('about:blank')).toBe('about:blank')
    expect(normalizeUrl(' https://x.dev/a ')).toBe('https://x.dev/a')
  })
})

describe('BrowserTools', () => {
  /** Page script answers by method name, read from the evaluated expression. */
  function service(page: (method: string, expression: string) => unknown, ensureOutput = 'STATE=ready\n') {
    const chrome = fakeChrome((method, params) => {
      if (method === 'Target.attachToTarget') return { sessionId: `S-${String(params.targetId)}` }
      if (method === 'Runtime.evaluate') {
        const expression = String(params.expression)
        const called = /\}\)\(\)\.(\w+)\(/.exec(expression)?.[1] ?? ''
        return { result: { value: page(called, expression) } }
      }
      return {}
    })
    const execs: Array<{ user?: string; env?: Record<string, string> }> = []
    const guest = {
      exec: async (req: { user?: string; env?: Record<string, string> }) => {
        execs.push(req)
        return { code: 0, signal: null, stdout: ensureOutput, stderr: '' }
      },
      listProcs: async () => ({ procs: [] }),
    }
    const vm = {
      guest: async () => guest,
      runningGuest: () => guest,
      status: () => ({ state: 'running' }),
      subscribe: () => () => {},
    } as unknown as VmController
    const service = new BrowserService({ vm, settleMs: 0, channel: () => chrome.channel })
    const browser = Object.assign(new BrowserTools({ browser: service }), { close: () => service.close() })
    return { browser, sent: chrome.sent, execs }
  }

  const bot = makeBot({ slug: 'iris', displayNum: 4 })
  const ctx: ToolExecContext = {
    bot,
    conversationId: null,
    turnId: null,
    signal: new AbortController().signal,
  }
  const textOf = (r: ToolResult) => (r.content[0] as { text: string }).text
  const state = { url: 'https://mail.google.com/', title: 'Inbox', docId: 'd1', ready: 'complete' }

  it('starts Chrome with the bot port, reads the front tab and keeps refs unique across pages', async () => {
    const starts: number[] = []
    const { browser, execs } = service((method, expression) => {
      if (method === 'state') return state
      if (method === 'snapshot') {
        starts.push(Number(/"start":(\d+)/.exec(expression)?.[1]))
        return {
          ...state,
          next: 7,
          vw: 1280,
          vh: 720,
          scrollY: 0,
          scrollH: 720,
          tree: ['Hello'],
          above: 0,
          below: 0,
          truncated: false,
        }
      }
      return null
    }, 'RESTARTED=1\nSTATE=started\n')
    const first = await browser.execute(ctx, { id: '1', name: 'browser_snapshot', arguments: {} })
    expect(textOf(first)).toContain('Chrome was restarted')
    expect(textOf(first)).toContain('Page: Inbox')
    expect(first.activity?.detail).toBe('Inbox')
    expect(execs[0]).toMatchObject({ user: 'root', env: { SLUG: 'iris', PORT: '9226', DISPLAY_NUM: '4' } })
    await browser.execute(ctx, { id: '2', name: 'browser_snapshot', arguments: {} })
    expect(starts).toEqual([1, 8])
    expect(execs).toHaveLength(1)
    await browser.close()
  })

  it('clicks the point the page resolves for a ref, and explains stale or covered refs', async () => {
    const { browser, sent } = service((method, expression) => {
      if (method === 'state') return state
      if (method === 'point') {
        if (expression.includes('"e9"')) return { error: 'stale' }
        if (expression.includes('"e8"'))
          return { error: 'covered', what: 'button "Send" [e8]', by: 'dialog "Cookies"' }
        return { x: 100, y: 200, what: 'button "Archive" [e5]' }
      }
      return null
    })
    const ok = await browser.execute(ctx, { id: '1', name: 'browser_click', arguments: { ref: 'e5' } })
    expect(textOf(ok)).toBe('Clicked button "Archive" [e5].')
    expect(ok.activity?.detail).toBe('Archive')
    const mouse = sent.filter((s) => s.method === 'Input.dispatchMouseEvent').map((s) => s.params)
    expect(mouse.map((m) => m.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    expect(mouse[1]).toMatchObject({ x: 100, y: 200, button: 'left', clickCount: 1 })
    expect(sent.find((s) => s.method === 'Input.dispatchMouseEvent')?.sessionId).toBe('S-T1')

    const stale = await browser.execute(ctx, { id: '2', name: 'browser_click', arguments: { ref: 'e9' } })
    expect(stale.isError).toBe(true)
    expect(textOf(stale)).toContain('e9 is not on the current page')
    const covered = await browser.execute(ctx, { id: '3', name: 'browser_click', arguments: { ref: 'e8' } })
    expect(textOf(covered)).toContain('is covered by dialog "Cookies"')
    const bad = await browser.execute(ctx, { id: '4', name: 'browser_click', arguments: { ref: 'Archive' } })
    expect(textOf(bad)).toContain('must be an element ref')
    await browser.close()
  })

  it('types by replacing the field content and submits with Enter', async () => {
    const { browser, sent } = service((method) => {
      if (method === 'state') return state
      if (method === 'focus') return { what: 'searchbox "Search mail" [e3]', hadText: true }
      return null
    })
    const res = await browser.execute(ctx, {
      id: '1',
      name: 'browser_type',
      arguments: { ref: 'e3', text: 'from:ana', submit: true },
    })
    expect(textOf(res)).toBe('Typed into searchbox "Search mail" [e3] and pressed Enter.')
    expect(sent.find((s) => s.method === 'Input.insertText')?.params).toEqual({ text: 'from:ana' })
    const keys = sent
      .filter((s) => s.method === 'Input.dispatchKeyEvent')
      .map((s) => `${s.params.type}:${s.params.key}`)
    expect(keys).toEqual(['keyDown:Enter', 'keyUp:Enter'])
    await browser.close()
  })
  it('clicks editors that refuse focus, presses the key after typing and reports the field and new notices', async () => {
    let noticeCalls = 0
    const { browser, sent } = service((method) => {
      if (method === 'state') return state
      if (method === 'focus')
        return { what: 'combobox "To" [e3]', hadText: false, focused: false, x: 10, y: 20 }
      if (method === 'notices') {
        noticeCalls++
        const compose = { key: 'dialog "New message"', line: 'dialog "New message": …' }
        return {
          items:
            noticeCalls === 1
              ? [compose]
              : [compose, { key: 'invalid field: option "x"', line: 'invalid field: option "x"' }],
          next: 60,
        }
      }
      if (method === 'fieldState')
        return { what: 'combobox "To" [e3]', value: '', chips: ['Ana <a@x.io>', 'x (invalid)'] }
      return null
    })
    const res = await browser.execute(ctx, {
      id: '1',
      name: 'browser_type',
      arguments: { ref: 'e3', text: 'x', key: 'Tab' },
    })
    expect(textOf(res)).toBe(
      [
        'Typed into combobox "To" [e3] and pressed Tab.',
        'Field now: chips "Ana <a@x.io>", "x (invalid)" · no text',
        'Now on the page (read it before acting again):',
        '- invalid field: option "x"',
      ].join('\n'),
    )
    const order = sent
      .filter((s) => s.method.startsWith('Input.'))
      .map((s) => `${s.method}:${String(s.params.type ?? s.params.text)}`)
    expect(order).toEqual([
      'Input.dispatchMouseEvent:mouseMoved',
      'Input.dispatchMouseEvent:mousePressed',
      'Input.dispatchMouseEvent:mouseReleased',
      'Input.insertText:x',
      'Input.dispatchKeyEvent:rawKeyDown',
      'Input.dispatchKeyEvent:keyUp',
    ])
    expect(sent.find((s) => s.method === 'Input.dispatchMouseEvent')?.params).toMatchObject({ x: 10, y: 20 })
    await browser.close()
  })
})
