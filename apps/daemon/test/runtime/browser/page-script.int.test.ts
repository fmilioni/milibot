import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { ToolExecContext, ToolResult } from '@milibot/agent'
import { makeBot } from '@milibot/agent/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BrowserService } from '../../../src/runtime/browser/service'
import { BrowserTools } from '../../../src/runtime/browser/tools'
import type { VmController } from '../../../src/runtime/vm/controller'
import { findChrome, type LocalChrome, startLocalChrome } from '../../support/local-chrome'

/**
 * The page script and the browser tools against a real (headless, local) Chrome and realistic pages:
 * a webmail compose dialog with recipient chips, a chat composer, a search combobox and a form with errors.
 */
const chromePath = findChrome()

function fixture(name: string): string {
  return pathToFileURL(join(import.meta.dirname, '..', '..', 'fixtures', 'browser', name)).href
}

// Portuguese on purpose: the fixture pages are Portuguese (accented labels, accent-insensitive search).
describe.skipIf(!chromePath)('browser tools on real pages', () => {
  let chrome: LocalChrome
  let browser: BrowserService
  let tools: BrowserTools
  const ctx: ToolExecContext = {
    bot: makeBot({ slug: 'mika', displayNum: 3 }),
    conversationId: null,
    turnId: null,
    signal: new AbortController().signal,
  }
  let n = 0
  const call = async (name: string, args: Record<string, unknown>) => {
    const result: ToolResult = await tools.execute(ctx, { id: String(++n), name, arguments: args })
    return (result.content[0] as { text: string }).text
  }
  /** Ref of the first snapshot line matching `pattern`. */
  const refOf = (snapshot: string, pattern: RegExp): string => {
    const line = snapshot.split('\n').find((l) => pattern.test(l))
    const ref = line && /\[(e\d+)\]/.exec(line)?.[1]
    if (!ref) throw new Error(`no ref for ${pattern} in:\n${snapshot}`)
    return ref
  }

  beforeAll(async () => {
    chrome = await startLocalChrome(chromePath as string)
    const guest = {
      exec: async () => ({ code: 0, signal: null, stdout: 'STATE=ready\n', stderr: '' }),
      listProcs: async () => ({ procs: [] }),
    }
    const vm = {
      guest: async () => guest,
      runningGuest: () => guest,
      status: () => ({ state: 'running' }),
      subscribe: () => () => {},
    } as unknown as VmController
    browser = new BrowserService({ vm, settleMs: 250, channel: () => chrome.channel() })
    tools = new BrowserTools({ browser })
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    await chrome?.close()
  })

  it('lists a compose dialog first, with its fields, chips and body, even on a huge page', async () => {
    await call('browser_navigate', { url: fixture('mail-compose.html') })
    const snap = await call('browser_snapshot', {})
    const lines = snap.split('\n')
    const dialog = lines.indexOf('- dialog "Nova mensagem":')
    expect(dialog).toBeGreaterThan(0)
    expect(lines.findIndex((l) => l.startsWith('- banner'))).toBeGreaterThan(dialog)
    expect(snap).toMatch(
      /- combobox "Destinatários em Para" \[e\d+\] chips: "Beatriz Ferreira <beatriz\.ferreira@example\.com>"/,
    )
    expect(snap).toMatch(/- option "Beatriz Ferreira" \[e\d+\] · \[button: Remover destinatário\]\(e\d+\)/)
    expect(snap).toMatch(/- textbox "Assunto" \[e\d+\]\n/)
    expect(snap).toMatch(/- textbox "Corpo da mensagem" \[e\d+\] \[multiline\]/)
    expect(snap).not.toContain('parts were skipped')

    const search = await call('browser_snapshot', { search: 'para|destinatarios' })
    expect(search).toContain('- dialog "Nova mensagem":')
    expect(search).toMatch(/combobox "Destinatários em Para" \[e\d+\]/)
  })

  it('types into the recipient combobox, reports chips and suggestions, and the error dialog it causes', async () => {
    await call('browser_navigate', { url: fixture('mail-compose.html') })
    const snap = await call('browser_snapshot', { search: 'Nova mensagem|Para|Enviar' })
    const to = refOf(snap, /combobox "Destinatários em Para"/)
    const send = refOf(snap, /button "Enviar"/)

    const suggested = await call('browser_type', { ref: to, text: 'Car' })
    expect(suggested).toMatch(/Field now: chips "Beatriz Ferreira <[^>]+>" · text "Car"/)
    expect(suggested).toMatch(
      /suggestions: \[Carla Mendes <carla\.mendes@example\.com> \(selected\)\]\(e\d+\)/,
    )
    const picked = await call('browser_type', { ref: to, text: 'Car', key: 'Enter' })
    expect(picked).toContain('and pressed Enter')
    expect(picked).toMatch(
      /chips "Beatriz Ferreira <[^>]+>", "Carla Mendes <carla\.mendes@example\.com>" · no text/,
    )

    const wrong = await call('browser_type', { ref: to, text: 'Mensagem', key: 'Tab' })
    expect(wrong).toContain('"Mensagem (invalid)"')
    expect(wrong).toContain(
      'Now on the page (read it before acting again):\n- invalid field: option "Mensagem"',
    )

    const clicked = await call('browser_click', { ref: send })
    expect(clicked).toMatch(
      /- alertdialog "Erro" \(modal\): O endereço "Mensagem" no campo "Para" não foi reconhecido\..* \[OK\]\(e\d+\)/,
    )
    const again = await call('browser_click', { ref: send })
    expect(again).toContain('is covered by alertdialog "Erro"')

    const withDialog = await call('browser_snapshot', {})
    expect(withDialog.split('\n').find((l) => l.startsWith('- '))).toBe('- alertdialog "Erro" [modal]:')
    expect(withDialog).toContain('A modal dialog is open: the page behind it is not listed')
    expect(withDialog).not.toContain('- banner')
  })

  it('types into a contenteditable composer (replacing its text) and submits with Enter', async () => {
    await call('browser_navigate', { url: fixture('chat-composer.html') })
    const snap = await call('browser_snapshot', {})
    expect(snap).toMatch(
      /- textbox "Mensagem para geral" \[e\d+\] \[multiline\] placeholder "Enviar mensagem para #geral"/,
    )
    const box = refOf(snap, /textbox "Mensagem para geral"/)
    await call('browser_type', { ref: box, text: 'rascunho' })
    const typed = await call('browser_type', { ref: box, text: 'Relatório revisado' })
    expect(typed).toContain('Field now: text "Relatório revisado"')
    const sent = await call('browser_type', { ref: box, text: 'Pronto!', key: 'Enter' })
    expect(sent).toContain('- status: Enviado: Pronto!')
    const after = await call('browser_snapshot', {})
    expect(after).toMatch(/Focused: textbox "Mensagem para geral" \[e\d+\]/)
    expect(after).toMatch(/- status: Enviado: Pronto!/)
  })

  it('reads a search combobox with a label, its inner input and its suggestions', async () => {
    await call('browser_navigate', { url: fixture('search-combobox.html') })
    const snap = await call('browser_snapshot', {})
    expect(snap).toMatch(
      /- combobox "Pacote" \[e\d+\] · \[searchbox: Pacote \(placeholder "Nome do pacote"\)\]\(e\d+\)/,
    )
    const box = refOf(snap, /combobox "Pacote"/)
    const typed = await call('browser_type', { ref: box, text: 'deb' })
    expect(typed).toMatch(
      /suggestions: \[debian-archive-keyring \(selected\)\]\(e\d+\) \[debianutils\]\(e\d+\) \[debconf\]\(e\d+\)/,
    )
    const listed = await call('browser_snapshot', { search: 'debconf' })
    expect(listed).toMatch(/option "debconf" \[e\d+\]/)
    await call('browser_press_key', { key: 'Enter' })
    expect(await call('browser_snapshot', {})).toContain('Escolhido: debian-archive-keyring')
  })

  it('shows hints, labels from aria-labelledby and invalid fields with their message', async () => {
    await call('browser_navigate', { url: fixture('form-errors.html') })
    const snap = await call('browser_snapshot', { search: 'card|zip|notes' })
    expect(snap).toMatch(/textbox: Card number/)
    expect(snap).toMatch(/textbox: ZIP/)
    expect(snap).toMatch(/textbox "Delivery notes" \[e\d+\] \[multiline\]/)
    const pay = refOf(await call('browser_snapshot', {}), /button "Pay"/)
    const clicked = await call('browser_click', { ref: pay })
    expect(clicked).toMatch(
      /- alertdialog "Payment failed" \(modal\): We could not process your card\..*\[Close\]\(e\d+\)/,
    )
    expect(clicked).toMatch(/- invalid field: textbox "ZIP" \[e\d+\] — Enter a valid ZIP code/)
    const full = await call('browser_snapshot', { search: 'zip' })
    expect(full).toMatch(/textbox: ZIP \(invalid\)/)
  })
})
