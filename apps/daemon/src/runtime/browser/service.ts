import { setTimeout as sleep } from 'node:timers/promises'

import type { ToolResult } from '@milibot/agent'
import { ToolInputError, toolText } from '@milibot/agent/tools'
import type { Bot, LogFn } from '@milibot/shared'

import { errorMessage } from '../../errors'
import { CdpClient, CdpError, GuestRelayChannel, type LineChannel, type TabInfo } from '../cdp'
import { type GuestClient, onVmTransition, type VmController } from '../vm'
import { keyComboEvents } from './keys'
import { cdpPort, ENSURE_BROWSER_SCRIPT, parseEnsureOutput } from './launcher'
import { pageCall } from './page-script'
import {
  DEFAULT_FULL_SNAPSHOT_TOKENS,
  DEFAULT_SNAPSHOT_TOKENS,
  formatSnapshot,
  type PageSnapshot,
} from './snapshot'

export interface BrowserDeps {
  vm: VmController
  log?: LogFn
  /** A connection unused for this long is closed (Chrome keeps running). */
  idleMs?: number
  /** Pause after an action for the page to react. */
  settleMs?: number
  /** Line channel to Chrome; the default is the relay process in the VM. */
  channel?: (bot: Bot, port: number) => LineChannel
}

export interface BrowserSession {
  bot: Bot
  client: CdpClient
  attached: Map<string, string>
  idleTimer: NodeJS.Timeout | null
}

export interface PageState {
  url: string
  title: string
  docId: string
  ready: string
}

export class BrowserInputError extends ToolInputError {}

interface Notice {
  key: string
  line: string
}

function isPage(tab: TabInfo): boolean {
  return tab.type === 'page' && !/^(devtools|chrome-extension|chrome-untrusted):/.test(tab.url)
}

/** Dialogs/alerts that appeared (or changed) with an action, for the tool result. */
function newNotices(before: Notice[], after: Notice[]): string {
  const seen = new Set(before.map((n) => n.key))
  const fresh = after.filter((n) => !seen.has(n.key))
  if (fresh.length === 0) return ''
  return `\nNow on the page (read it before acting again):\n${fresh.map((n) => `- ${n.line}`).join('\n')}`
}

/**
 * The bots' own Chrome in the VM, driven over the DevTools protocol through a relay process started by the
 * guest agent: one connection per bot, and the page operations the browser tools are made of.
 */
export class BrowserService {
  private readonly sessions = new Map<string, BrowserSession>()
  private readonly connecting = new Map<string, Promise<{ session: BrowserSession; restarted: boolean }>>()
  /** Refs never repeat for a bot (per daemon run): a ref from an older page can't hit a new element. */
  private readonly nextRef = new Map<string, number>()
  private staleRelaysKilled = false
  private readonly unsubscribe: () => void

  constructor(private readonly deps: BrowserDeps) {
    this.unsubscribe = onVmTransition(deps.vm, {
      down: () => {
        this.staleRelaysKilled = false
        for (const id of [...this.sessions.keys()]) this.drop(id)
      },
    })
  }

  get settleMs(): number {
    return this.deps.settleMs ?? 400
  }

  /** The bot's connection (made on first use); `restarted` when Chrome had to restart to get its port. */
  session(bot: Bot): Promise<{ session: BrowserSession; restarted: boolean }> {
    const existing = this.sessions.get(bot.id)
    if (existing && !existing.client.closed && existing.bot.displayNum === bot.displayNum) {
      this.touch(existing)
      return Promise.resolve({ session: existing, restarted: false })
    }
    const pending = this.connecting.get(bot.id)
    if (pending) return pending
    const connect = this.connect(bot)
      .then((result) => {
        this.touch(result.session)
        return result
      })
      .finally(() => this.connecting.delete(bot.id))
    this.connecting.set(bot.id, connect)
    return connect
  }

  private async connect(bot: Bot): Promise<{ session: BrowserSession; restarted: boolean }> {
    this.drop(bot.id)
    const guest = await this.deps.vm.guest()
    await this.killStaleRelays(guest)
    const port = cdpPort(bot.displayNum)
    const ensured = await guest.exec({
      user: 'root',
      cmd: ENSURE_BROWSER_SCRIPT,
      cwd: '/',
      env: { SLUG: bot.slug, PORT: String(port), DISPLAY_NUM: String(bot.displayNum) },
      timeoutMs: 60_000,
    })
    const state = parseEnsureOutput(ensured.stdout)
    if (state.state !== 'ready' && state.state !== 'started') {
      this.log('warn', 'browser not available', {
        bot: bot.slug,
        state: state.state,
        stderr: ensured.stderr.slice(-500),
      })
      throw new Error(
        state.state === 'still_running'
          ? 'your Chrome did not close to enable the browser tools; close it (or use the computer tool)'
          : `could not start Chrome with the browser tools (${state.state})`,
      )
    }
    if (state.restarted) this.log('info', 'restarted Chrome with the DevTools port', { bot: bot.slug })
    const client = new CdpClient(
      this.deps.channel?.(bot, port) ??
        new GuestRelayChannel(() => this.deps.vm.runningGuest(), { port, label: `browser:${bot.slug}` }),
    )
    await client.open()
    const session: BrowserSession = { bot, client, attached: new Map(), idleTimer: null }
    client.on((method, params) => {
      if (method === 'Target.detachedFromTarget') {
        const sessionId = (params as { sessionId?: string }).sessionId
        for (const [target, id] of session.attached) if (id === sessionId) session.attached.delete(target)
      }
    })
    this.sessions.set(bot.id, session)
    return { session, restarted: state.restarted }
  }

  /** Relays left by a previous runtime (it crashed or restarted) hold connections to Chrome. */
  private async killStaleRelays(guest: GuestClient): Promise<void> {
    if (this.staleRelaysKilled) return
    this.staleRelaysKilled = true
    try {
      await guest.killProcs('browser:')
    } catch (err) {
      this.log('warn', 'could not list guest processes', { err: errorMessage(err) })
    }
  }

  private touch(session: BrowserSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.idleTimer = setTimeout(() => this.drop(session.bot.id), this.deps.idleMs ?? 10 * 60_000)
    session.idleTimer.unref?.()
  }

  drop(botId: string): void {
    const session = this.sessions.get(botId)
    if (!session) return
    this.sessions.delete(botId)
    if (session.idleTimer) clearTimeout(session.idleTimer)
    void session.client.close().catch(() => undefined)
  }

  /** Closes the relays (Chrome itself keeps running). */
  async close(): Promise<void> {
    this.unsubscribe()
    for (const id of [...this.sessions.keys()]) this.drop(id)
  }

  private log(...args: Parameters<LogFn>): void {
    this.deps.log?.(...args)
  }

  async pages(session: BrowserSession): Promise<TabInfo[]> {
    return (await session.client.tabs()).filter(isPage)
  }

  /** The tab in front: Chrome lists the most recently active first. A window with no tab gets one. */
  private async activeTab(session: BrowserSession): Promise<{ tab: TabInfo; count: number }> {
    let pages = await this.pages(session)
    if (pages.length === 0) {
      await session.client.send('Target.createTarget', { url: 'about:blank' })
      pages = await this.pages(session)
    }
    const tab = pages[0]
    if (!tab) throw new CdpError('Chrome has no open tab')
    return { tab, count: pages.length }
  }

  async attach(session: BrowserSession, targetId: string): Promise<string> {
    const known = session.attached.get(targetId)
    if (known) return known
    const { sessionId } = await session.client.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    })
    session.attached.set(targetId, sessionId)
    return sessionId
  }

  async evaluate<T>(session: BrowserSession, sessionId: string, expression: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await session.client.evaluate<T>(expression, sessionId, { userGesture: true })
      } catch (err) {
        // A navigation replaces the page's execution context mid-call.
        const retry =
          err instanceof CdpError && /context|navigat|Target closed|Inspected target/i.test(err.message)
        if (!retry || attempt >= 10) throw err
        await sleep(300)
      }
    }
  }

  async current(session: BrowserSession): Promise<{ sessionId: string; tab: TabInfo; count: number }> {
    const { tab, count } = await this.activeTab(session)
    return { sessionId: await this.attach(session, tab.id), tab, count }
  }

  state(session: BrowserSession, sessionId: string): Promise<PageState> {
    return this.evaluate<PageState>(session, sessionId, pageCall('state'))
  }

  /** Waits for the page an action may have started to load, and for new tabs to take the front. */
  async settle(session: BrowserSession, before: { tabId: string; state: PageState | null }): Promise<string> {
    await sleep(this.settleMs)
    const { sessionId, tab } = await this.current(session)
    if (tab.id !== before.tabId) {
      await this.waitLoaded(session, sessionId)
      const now = await this.state(session, sessionId)
      return ` A new tab opened: ${now.title || '(untitled)'} — ${now.url}`
    }
    const now = await this.waitLoaded(session, sessionId)
    if (before.state && (now.docId !== before.state.docId || now.url !== before.state.url))
      return ` Now on: ${now.title || '(untitled)'} — ${now.url}`
    return ''
  }

  async waitLoaded(session: BrowserSession, sessionId: string, timeoutMs = 15_000): Promise<PageState> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const state = await this.state(session, sessionId)
      if (state.ready !== 'loading' || Date.now() > deadline) return state
      await sleep(250)
    }
  }

  async snapshotText(
    session: BrowserSession,
    sessionId: string,
    count: number,
    options: { full?: boolean; search?: string; page?: number; maxTokens?: number } = {},
  ): Promise<{ text: string; tokens: number; title: string; url: string }> {
    const botId = session.bot.id
    const snap = await this.evaluate<PageSnapshot>(
      session,
      sessionId,
      pageCall('snapshot', { full: !!options.full || !!options.search, start: this.nextRef.get(botId) ?? 1 }),
    )
    this.trackRefs(botId, snap.next)
    const formatted = formatSnapshot(snap, {
      full: !!options.full,
      maxTokens: options.maxTokens ?? (options.full ? DEFAULT_FULL_SNAPSHOT_TOKENS : DEFAULT_SNAPSHOT_TOKENS),
      page: options.page ?? 1,
      tabs: count,
      ...(options.search ? { search: options.search } : {}),
    })
    return { text: formatted.text, tokens: formatted.tokens, title: snap.title, url: snap.url }
  }

  /** Refs the page handed out outside a snapshot (dialog buttons, suggestions) must not be reused. */
  trackRefs(botId: string, next: unknown): void {
    if (typeof next === 'number') this.nextRef.set(botId, Math.max(this.nextRef.get(botId) ?? 1, next + 1))
  }

  async notices(session: BrowserSession, sessionId: string): Promise<Notice[]> {
    try {
      const res = await this.evaluate<{ items?: Notice[]; next?: number } | null>(
        session,
        sessionId,
        pageCall('notices'),
      )
      this.trackRefs(session.bot.id, res?.next)
      return Array.isArray(res?.items) ? res.items : []
    } catch (err) {
      if (err instanceof CdpError && /context|navigat|Target closed/i.test(err.message)) return []
      throw err
    }
  }

  /** After an action: dialogs, alerts or invalid fields it brought up (none if the page changed). */
  async noticesAfter(session: BrowserSession, before: Notice[]): Promise<string> {
    const { sessionId } = await this.current(session)
    return newNotices(before, await this.notices(session, sessionId))
  }

  async withSnapshot(
    session: BrowserSession,
    message: string,
    wanted: boolean,
    activity: ToolResult['activity'],
  ): Promise<ToolResult> {
    if (!wanted) return toolText(message, false, activity)
    const { sessionId, count } = await this.current(session)
    const snap = await this.snapshotText(session, sessionId, count)
    return toolText(`${message}\n\n${snap.text}`, false, activity)
  }

  /** Calls the page script's `method` on an element ref; a ref gone from the page is an input error. */
  async pageCall<T extends { error?: string }>(
    session: BrowserSession,
    sessionId: string,
    ref: string,
    method: string,
    ...rest: unknown[]
  ): Promise<T> {
    const result = await this.evaluate<T>(session, sessionId, pageCall(method, ref, ...rest))
    if (result?.error === 'stale')
      throw new BrowserInputError(
        `${ref} is not on the current page (it changed); take a new browser_snapshot`,
      )
    return result
  }

  async keys(session: BrowserSession, sessionId: string, combo: string): Promise<void> {
    for (const event of keyComboEvents(combo))
      await session.client.send('Input.dispatchKeyEvent', { ...event }, sessionId)
  }

  async click(session: BrowserSession, sessionId: string, point: { x: number; y: number }): Promise<void> {
    await session.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, sessionId)
    for (const type of ['mousePressed', 'mouseReleased'])
      await session.client.send(
        'Input.dispatchMouseEvent',
        { type, ...point, button: 'left', clickCount: 1 },
        sessionId,
      )
  }
}
