import { setTimeout as sleep } from 'node:timers/promises'

import type { ToolExecContext, ToolResult } from '@milibot/agent'
import {
  describeSecretRefs,
  flagArg,
  numberArg,
  optionalNumber,
  optionalString,
  rawTextArg,
  textArg,
  type ToolArgs,
  toolError,
  ToolInputError,
  toolText,
} from '@milibot/agent/tools'
import type { Bot } from '@milibot/shared'

import { errorMessage } from '../../errors'
import { CdpError, type TabInfo } from '../cdp'
import { SecretRefError } from '../credentials'
import { oneLine, type ToolHandlers, ToolSwitch } from '../tools-core'
import { keyComboEvents } from './keys'
import { pageCall } from './page-script'
import { BrowserInputError, type BrowserService, type BrowserSession } from './service'

export interface BrowserToolsDeps {
  browser: BrowserService
  /** `{{secret:NAME}}` in `browser_type` text → the value (throws `SecretRefError` for unknown names). */
  resolveSecretRefs?: (bot: Bot, text: string) => string
}

interface FieldState {
  what?: string
  value?: string
  chips?: string[]
  invalid?: boolean
  message?: string
  options?: Array<{ ref: string; n: string; selected?: boolean }>
  next?: number
  error?: string
}

type BrowserTool = (session: BrowserSession, a: ToolArgs, signal: AbortSignal) => Promise<ToolResult>

/** "mail.google.com/mail/u/0" from a URL, for step details. */
function shortUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.protocol === 'about:' || u.protocol === 'chrome:') return url
    return oneLine(`${u.host}${u.pathname === '/' ? '' : u.pathname}`, 60)
  } catch {
    return oneLine(url, 60)
  }
}

export function normalizeUrl(raw: string): string {
  const url = raw.trim()
  if (!url) throw new BrowserInputError('"url" is required')
  if (/^(localhost|127\.|\[::1\])/i.test(url)) return `http://${url}`
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(url)) return url
  return `https://${url}`
}

function refArg(a: ToolArgs): string {
  const ref = textArg(a, 'ref')
    .replace(/^\[|\]$/g, '')
    .replace(/^ref=/, '')
  if (!/^e\d+$/.test(ref))
    throw new BrowserInputError('"ref" must be an element ref from browser_snapshot, like "e12"')
  return ref
}

/** Option values as given (a single string counts as one); other items are skipped. */
function optionValues(a: ToolArgs): string[] {
  const value = a.values
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  return typeof value === 'string' ? [value] : []
}

function quoted(value: string): string {
  return `"${value.replace(/"/g, "'")}"`
}

/** "Field now: chips "Ana", "Bia" · text "abc" (invalid: …) · suggestions: [Ana](e51)". */
function describeField(state: FieldState): string {
  const parts: string[] = []
  if (state.chips?.length) parts.push(`chips ${state.chips.map(quoted).join(', ')}`)
  parts.push(state.value ? `text ${quoted(oneLine(state.value, 200))}` : 'no text')
  let line = `Field now: ${parts.join(' · ')}`
  if (state.invalid) line += ` (marked invalid${state.message ? `: ${state.message}` : ''})`
  if (state.options?.length)
    line += ` · suggestions: ${state.options.map((o) => `[${o.n}${o.selected ? ' (selected)' : ''}](${o.ref})`).join(' ')}`
  return line
}

/** Element summary from the page script ("button "Archive" [e14]") → just the name, for the activity card. */
function elementName(what: unknown): string {
  const s = typeof what === 'string' ? what : ''
  const quoted = /"(.*)"/.exec(s)
  return quoted?.[1] ?? s.replace(/\s*\[e\d+\]$/, '')
}

/**
 * Browser tools (`browser_*`): read pages as compact text snapshots (`snapshot.ts`) and act on elements by
 * ref, in the bot's own Chrome (`BrowserService`).
 */
export class BrowserTools extends ToolSwitch {
  readonly name = 'browser'
  protected readonly handlers: ToolHandlers = {
    browser_snapshot: this.tool((s, a) => this.snapshot(s, a)),
    browser_navigate: this.tool((s, a) => this.navigate(s, a)),
    browser_click: this.tool((s, a) => this.click(s, a)),
    browser_type: this.tool((s, a) => this.type(s, a)),
    browser_press_key: this.tool((s, a) => this.pressKey(s, a)),
    browser_select_option: this.tool((s, a) => this.selectOption(s, a)),
    browser_scroll: this.tool((s, a) => this.scroll(s, a)),
    browser_wait_for: this.tool((s, a, signal) => this.waitFor(s, a, signal)),
    browser_tabs: this.tool((s, a) => this.tabs(s, a)),
  }

  constructor(private readonly deps: BrowserToolsDeps) {
    super()
  }

  private get browser(): BrowserService {
    return this.deps.browser
  }

  /** Runs a tool on the bot's connection; a CDP failure drops the connection so the next call reconnects. */
  private tool(run: BrowserTool) {
    return async (ctx: ToolExecContext, a: ToolArgs): Promise<ToolResult> => {
      try {
        const { session, restarted } = await this.browser.session(ctx.bot)
        const result = await run(session, a, ctx.signal)
        const first = result.content[0]
        if (!restarted || first?.type !== 'text') return result
        const note = 'Note: your Chrome was restarted to enable these tools; its tabs were restored.\n'
        return { ...result, content: [{ type: 'text', text: note + first.text }, ...result.content.slice(1)] }
      } catch (err) {
        if (err instanceof CdpError) this.browser.drop(ctx.bot.id)
        throw err
      }
    }
  }

  protected override mapError(err: unknown): ToolResult | undefined {
    if (err instanceof ToolInputError || err instanceof SecretRefError) return undefined
    if (err instanceof CdpError)
      return toolError(
        `Browser error: ${err.message}. Try again; if it keeps failing, use the computer tool.`,
      )
    return toolError(`Browser error: ${errorMessage(err)}`)
  }

  private async snapshot(session: BrowserSession, a: ToolArgs): Promise<ToolResult> {
    const { sessionId, count } = await this.browser.current(session)
    await this.browser.waitLoaded(session, sessionId, 5000)
    const search = textArg(a, 'search')
    const page = optionalNumber(a, 'page')
    const maxTokens = optionalNumber(a, 'max_tokens')
    const snap = await this.browser.snapshotText(session, sessionId, count, {
      full: flagArg(a, 'full') === true,
      ...(search ? { search } : {}),
      ...(page !== undefined ? { page } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    })
    const title = oneLine(snap.title || shortUrl(snap.url), 80)
    return toolText(snap.text, false, {
      detail: title,
      fullDetail: `${title} — ${snap.url} · ~${snap.tokens} tokens`,
    })
  }

  private async navigate(session: BrowserSession, a: ToolArgs): Promise<ToolResult> {
    const raw = textArg(a, 'url')
    const { client } = session
    const { sessionId } = await this.browser.current(session)
    const direction = raw.toLowerCase()
    if (direction === 'reload') await client.send('Page.reload', {}, sessionId)
    else if (direction === 'back' || direction === 'forward') {
      const history = await client.send<{ currentIndex: number; entries: Array<{ id: number }> }>(
        'Page.getNavigationHistory',
        {},
        sessionId,
      )
      const entry = history.entries[history.currentIndex + (direction === 'back' ? -1 : 1)]
      if (!entry) return toolError(`There is no page to go ${direction} to.`)
      await client.send('Page.navigateToHistoryEntry', { entryId: entry.id }, sessionId)
    } else {
      const url = normalizeUrl(raw)
      const res = await client.send<{ errorText?: string }>('Page.navigate', { url }, sessionId, 45_000)
      if (res.errorText) return toolError(`Could not open ${url}: ${res.errorText}`)
    }
    await sleep(300)
    const state = await this.browser.waitLoaded(session, sessionId)
    const message = `Opened ${state.title || '(untitled)'} — ${state.url}`
    const detail =
      direction === 'back' || direction === 'forward' || direction === 'reload' ? '' : shortUrl(state.url)
    return this.browser.withSnapshot(session, message, flagArg(a, 'snapshot') === true, {
      detail,
      fullDetail: state.url,
    })
  }

  private async click(session: BrowserSession, a: ToolArgs): Promise<ToolResult> {
    const ref = refArg(a)
    const { sessionId, tab } = await this.browser.current(session)
    const before = await this.browser.state(session, sessionId)
    const noticesBefore = await this.browser.notices(session, sessionId)
    const point = await this.browser.pageCall<{
      x?: number
      y?: number
      what?: string
      error?: string
      by?: string
    }>(session, sessionId, ref, 'point')
    if (point.error === 'covered')
      return toolError(`${point.what} is covered by ${point.by}; close or dismiss that first.`)
    if (point.error) return toolError(`Cannot click ${point.what ?? ref}: it is not visible.`)
    const button = a.button === 'right' || a.button === 'middle' ? a.button : 'left'
    const x = point.x as number
    const y = point.y as number
    await session.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId)
    const clicks = flagArg(a, 'double') === true ? 2 : 1
    for (let n = 1; n <= clicks; n++) {
      for (const type of ['mousePressed', 'mouseReleased'])
        await session.client.send(
          'Input.dispatchMouseEvent',
          { type, x, y, button, clickCount: n },
          sessionId,
        )
    }
    const after = await this.browser.settle(session, { tabId: tab.id, state: before })
    const notices = after ? '' : await this.browser.noticesAfter(session, noticesBefore)
    return this.browser.withSnapshot(
      session,
      `Clicked ${point.what}.${after}${notices}`,
      flagArg(a, 'snapshot') === true,
      { detail: elementName(point.what) },
    )
  }

  private async type(session: BrowserSession, a: ToolArgs): Promise<ToolResult> {
    const ref = refArg(a)
    if (typeof a.text !== 'string') throw new BrowserInputError('"text" must be a string')
    const text = a.text
    const typed = this.deps.resolveSecretRefs?.(session.bot, text) ?? text
    const then = textArg(a, 'key') || (flagArg(a, 'submit') === true ? 'Enter' : null)
    if (then) keyComboEvents(then)
    const { sessionId, tab } = await this.browser.current(session)
    const append = flagArg(a, 'append') === true
    const noticesBefore = await this.browser.notices(session, sessionId)
    const focus = await this.browser.pageCall<{
      what?: string
      hadText?: boolean
      focused?: boolean
      x?: number
      y?: number
      error?: string
    }>(session, sessionId, ref, 'focus', !append)
    if (focus.error === 'not_editable')
      return toolError(`${focus.what} is not a text field; click it or use a field ref from the snapshot.`)
    if (focus.focused === false && typeof focus.x === 'number' && typeof focus.y === 'number') {
      // Some editors only take focus from a real click.
      await this.browser.click(session, sessionId, { x: focus.x, y: focus.y })
      await this.browser.pageCall(session, sessionId, ref, 'focus', !append)
    }
    if (typed) await session.client.send('Input.insertText', { text: typed }, sessionId)
    else if (!append && focus.hadText) await this.browser.keys(session, sessionId, 'Delete')
    let after = ''
    if (then) {
      // Suggestions (autocomplete, recipient pickers) show up a moment after typing.
      await sleep(this.browser.settleMs)
      const before = await this.browser.state(session, sessionId)
      await this.browser.keys(session, sessionId, then)
      after = await this.browser.settle(session, { tabId: tab.id, state: before })
    }
    let field = ''
    if (!after) {
      const state = await this.browser.evaluate<FieldState | null>(
        session,
        sessionId,
        pageCall('fieldState', ref),
      )
      if (state && !state.error) {
        this.browser.trackRefs(session.bot.id, state.next)
        field = `\n${describeField(state)}`
      }
    }
    const notices = after ? '' : await this.browser.noticesAfter(session, noticesBefore)
    const message = `Typed into ${focus.what}${then ? ` and pressed ${then}` : ''}.${after}${field}${notices}`
    return this.browser.withSnapshot(session, message, flagArg(a, 'snapshot') === true, {
      detail: oneLine(describeSecretRefs(text), 60),
    })
  }

  private async pressKey(session: BrowserSession, a: ToolArgs): Promise<ToolResult> {
    const key = rawTextArg(a, 'key')
    keyComboEvents(key)
    const repeat = numberArg(a, 'repeat', { min: 1, max: 20, fallback: 1, round: true })
    const { sessionId, tab } = await this.browser.current(session)
    const before = await this.browser.state(session, sessionId)
    const noticesBefore = await this.browser.notices(session, sessionId)
    for (let i = 0; i < repeat; i++) await this.browser.keys(session, sessionId, key)
    const after = await this.browser.settle(session, { tabId: tab.id, state: before })
    const notices = after ? '' : await this.browser.noticesAfter(session, noticesBefore)
    return this.browser.withSnapshot(
      session,
      `Pressed ${key}${repeat > 1 ? ` ×${repeat}` : ''}.${after}${notices}`,
      flagArg(a, 'snapshot') === true,
      { detail: repeat > 1 ? `${key} ×${repeat}` : key },
    )
  }

  private async selectOption(session: BrowserSession, a: ToolArgs): Promise<ToolResult> {
    const ref = refArg(a)
    const values = optionValues(a)
    if (values.length === 0) throw new BrowserInputError('"values" must list at least one option')
    const { sessionId, tab } = await this.browser.current(session)
    const before = await this.browser.state(session, sessionId)
    const noticesBefore = await this.browser.notices(session, sessionId)
    const res = await this.browser.pageCall<{
      what?: string
      selected?: string[]
      options?: string[]
      error?: string
    }>(session, sessionId, ref, 'select', values)
    if (res.error === 'not_select')
      return toolError(`${res.what} is not a <select>; click it and then the option instead.`)
    if (res.error === 'no_option')
      return toolError(`No such option. Options: ${(res.options ?? []).join(' | ')}`)
    const after = await this.browser.settle(session, { tabId: tab.id, state: before })
    const notices = after ? '' : await this.browser.noticesAfter(session, noticesBefore)
    const chosen = (res.selected ?? []).join(', ')
    return this.browser.withSnapshot(
      session,
      `Selected ${chosen} in ${res.what}.${after}${notices}`,
      flagArg(a, 'snapshot') === true,
      { detail: oneLine(chosen, 60) },
    )
  }

  private async scroll(session: BrowserSession, a: ToolArgs): Promise<ToolResult> {
    const { sessionId } = await this.browser.current(session)
    let message: string
    let detail = ''
    if (a.ref !== undefined) {
      const ref = refArg(a)
      const res = await this.browser.pageCall<{ what?: string; error?: string }>(
        session,
        sessionId,
        ref,
        'scrollInto',
      )
      message = `Scrolled to ${res.what}.`
      detail = elementName(res.what)
    } else {
      const direction = optionalString(a, 'direction') ?? 'down'
      if (!['up', 'down', 'left', 'right'].includes(direction))
        throw new BrowserInputError('direction must be up, down, left or right')
      const amount = numberArg(a, 'amount', { min: 0.1, max: 10, fallback: 1 })
      const view = await this.browser.evaluate<{ w: number; h: number }>(
        session,
        sessionId,
        '({ w: window.innerWidth, h: window.innerHeight })',
      )
      const vertical = direction === 'up' || direction === 'down'
      const sign = direction === 'up' || direction === 'left' ? -1 : 1
      const delta = Math.round(sign * amount * (vertical ? view.h : view.w) * 0.8)
      await session.client.send(
        'Input.dispatchMouseEvent',
        {
          type: 'mouseWheel',
          x: Math.round(view.w / 2),
          y: Math.round(view.h / 2),
          deltaX: vertical ? 0 : delta,
          deltaY: vertical ? delta : 0,
        },
        sessionId,
      )
      await sleep(350)
      message = `Scrolled ${direction}.`
    }
    return this.browser.withSnapshot(session, message, flagArg(a, 'snapshot') !== false, { detail })
  }

  private async waitFor(session: BrowserSession, a: ToolArgs, signal: AbortSignal): Promise<ToolResult> {
    const appear = textArg(a, 'text') || null
    const gone = textArg(a, 'text_gone') || null
    const seconds = numberArg(a, 'seconds', { min: 0.1, max: 30, fallback: appear || gone ? 10 : 2 })
    const detail = oneLine(appear ?? gone ?? '', 60)
    const snapshot = flagArg(a, 'snapshot') === true
    if (!appear && !gone) {
      await sleep(seconds * 1000)
      return this.browser.withSnapshot(session, `Waited ${seconds}s.`, snapshot, { detail })
    }
    const deadline = Date.now() + seconds * 1000
    for (;;) {
      if (signal.aborted) throw new Error('aborted')
      const { sessionId } = await this.browser.current(session)
      const present = appear
        ? await this.browser.evaluate<boolean>(session, sessionId, pageCall('hasText', appear))
        : true
      const absent = gone
        ? !(await this.browser.evaluate<boolean>(session, sessionId, pageCall('hasText', gone)))
        : true
      if (present && absent) {
        const what = appear ? `"${appear}" is on the page` : `"${gone}" is gone`
        return this.browser.withSnapshot(session, `Done: ${what}.`, snapshot, { detail })
      }
      if (Date.now() > deadline) {
        const what = appear ? `"${appear}" did not appear` : `"${gone}" is still there`
        return toolError(`Timed out after ${seconds}s: ${what}.`, { detail })
      }
      await sleep(300)
    }
  }

  private async tabs(session: BrowserSession, a: ToolArgs): Promise<ToolResult> {
    const action = optionalString(a, 'action') ?? 'list'
    const pages = await this.browser.pages(session)
    const pick = (): TabInfo => {
      const index = Math.round(optionalNumber(a, 'index') ?? 1)
      const tab = pages[index - 1]
      if (!tab) throw new BrowserInputError(`there is no tab ${index} (${pages.length} open)`)
      return tab
    }
    const list = (tabs: TabInfo[]) =>
      tabs
        .map((t, i) => `${i + 1}. ${i === 0 ? '[current] ' : ''}${t.title || '(untitled)'} — ${t.url}`)
        .join('\n')
    switch (action) {
      case 'list':
        return toolText(list(pages) || 'No tabs.', false, { detail: '' })
      case 'new': {
        const raw = textArg(a, 'url')
        const url = raw ? normalizeUrl(raw) : 'about:blank'
        const { targetId } = await session.client.send<{ targetId: string }>('Target.createTarget', { url })
        const sessionId = await this.browser.attach(session, targetId)
        // The tab starts on about:blank until the navigation commits.
        const deadline = Date.now() + 10_000
        while (url !== 'about:blank' && Date.now() < deadline) {
          if ((await this.browser.state(session, sessionId)).url !== 'about:blank') break
          await sleep(200)
        }
        const state = await this.browser.waitLoaded(session, sessionId)
        return toolText(`Opened a new tab: ${state.title || '(untitled)'} — ${state.url}`, false, {
          detail: shortUrl(state.url),
        })
      }
      case 'select': {
        const tab = pick()
        await session.client.send('Target.activateTarget', { targetId: tab.id })
        return toolText(`Switched to: ${tab.title || '(untitled)'} — ${tab.url}`, false, {
          detail: oneLine(tab.title || tab.url, 60),
        })
      }
      case 'close': {
        const tab = pick()
        await session.client.send('Target.closeTarget', { targetId: tab.id })
        session.attached.delete(tab.id)
        const rest = (await this.browser.pages(session)).slice(0, 10)
        return toolText(`Closed ${tab.title || tab.url}.\nOpen tabs:\n${list(rest) || 'none'}`, false, {
          detail: oneLine(tab.title || tab.url, 60),
        })
      }
      default:
        throw new BrowserInputError('action must be list, new, select or close')
    }
  }
}
