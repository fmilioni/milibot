import { setTimeout as sleep } from 'node:timers/promises'

import { type DesignProblem, type LogFn, PRINT_PREPARE_SCRIPT } from '@milibot/shared'

import { CdpClient, CdpError, GuestRelayChannel, type LineChannel } from '../cdp'
import { isVmRunning, onVmTransition, type VmController } from '../vm'
import { INSPECT_SCRIPT } from './scripts/inspect.generated'
import { KILL_STALE_RENDERER_SCRIPT } from './scripts/kill-stale-renderer.generated'
import { RENDER_CHROME_SCRIPT } from './scripts/render-chrome.generated'
import { WAIT_RENDERER_SCRIPT } from './scripts/wait-renderer.generated'

export interface RenderRequest {
  /** Document URL as the renderer's Chrome reaches it. */
  url: string
  width: number
  /** Null: measure the content height. */
  height: number | null
  /** Device scale of the screenshot. */
  scale: number
  screenshot: boolean
}

export interface RenderResult {
  /** Rendered height (the frame's, or the measured content height). */
  height: number
  /** Height of the content: taller than `height` when it runs past a fixed-height frame. */
  contentHeight?: number
  problems: DesignProblem[]
  outline: string[]
  png: Uint8Array | null
}

/** Renders frame documents: layout checks, screenshots and PDFs. */
export interface DesignRenderBackend {
  render(request: RenderRequest): Promise<RenderResult>
  /** PDF of a print document (one page per frame, named @page sizes). */
  pdf(url: string): Promise<Uint8Array>
  /** Can render right now without booting the VM (thumbnails only render then). */
  available(): boolean
  close(): Promise<void>
}

/** DevTools port of the headless renderer in the VM (below the bots' 9222 + display). */
const RENDER_CDP_PORT = 9199
const PROFILE = '/tmp/milibot-render'
const LABEL_CHROME = 'design:chrome'
const LABEL_RELAY = 'design:relay'

const RENDER_ENV = { RENDER_PORT: String(RENDER_CDP_PORT), RENDER_PROFILE: PROFILE }

export interface ChromeRendererDeps {
  vm: VmController
  /** Line channel to a Chrome already running (local headless Chrome in tests); skips the VM's Chrome. */
  channel?: () => LineChannel
  idleMs?: number
  log?: LogFn
}

/**
 * A headless Chrome in the VM, run as `agent` through `/procs` and driven over CDP through the same relay
 * as the browser tools. One job at a time; closed after `idleMs` without jobs and when the VM stops.
 */
export class ChromeDesignRenderer implements DesignRenderBackend {
  private client: CdpClient | null = null
  private chromeProc: string | null = null
  private connecting: Promise<CdpClient> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private idleTimer: NodeJS.Timeout | null = null
  private staleKilled = false
  private readonly unsubscribe: () => void

  constructor(private readonly deps: ChromeRendererDeps) {
    this.unsubscribe = deps.channel
      ? () => undefined
      : onVmTransition(deps.vm, {
          down: () => {
            this.staleKilled = false
            void this.shutdown(false).catch(() => undefined)
          },
        })
  }

  available(): boolean {
    return !!this.deps.channel || isVmRunning(this.deps.vm)
  }

  private async connect(): Promise<CdpClient> {
    if (this.client && !this.client.closed) return this.client
    if (this.connecting) return this.connecting
    this.connecting = this.open().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async open(): Promise<CdpClient> {
    await this.shutdown(false)
    let channel: LineChannel
    if (this.deps.channel) channel = this.deps.channel()
    else {
      const guest = await this.deps.vm.guest()
      if (!this.staleKilled) {
        this.staleKilled = true
        await guest.killProcs('design:').catch(() => 0)
        await guest.exec({
          user: 'agent',
          cmd: KILL_STALE_RENDERER_SCRIPT,
          env: RENDER_ENV,
          cwd: '/',
          timeoutMs: 15_000,
        })
      }
      const proc = await guest.startProc({
        user: 'agent',
        argv: ['bash', '-c', RENDER_CHROME_SCRIPT],
        cwd: '/',
        env: RENDER_ENV,
        label: LABEL_CHROME,
      })
      this.chromeProc = proc.id
      const ready = await guest.exec({
        user: 'agent',
        cmd: WAIT_RENDERER_SCRIPT,
        env: RENDER_ENV,
        cwd: '/',
        timeoutMs: 40_000,
      })
      if (ready.code !== 0) {
        await this.stopChrome()
        throw new CdpError('the renderer (headless Chrome in the VM) did not start')
      }
      channel = new GuestRelayChannel(() => this.deps.vm.runningGuest(), {
        port: RENDER_CDP_PORT,
        label: LABEL_RELAY,
      })
    }
    const client = new CdpClient(channel)
    await client.open()
    this.client = client
    return client
  }

  private async stopChrome(): Promise<void> {
    const id = this.chromeProc
    this.chromeProc = null
    // A stopped VM took the renderer with it (and `runningGuest()` throws).
    if (!id || !isVmRunning(this.deps.vm)) return
    try {
      await this.deps.vm.runningGuest().procSignal(id, 'SIGTERM')
    } catch {
      // Already gone.
    }
  }

  private async shutdown(unsubscribe: boolean): Promise<void> {
    if (unsubscribe) this.unsubscribe()
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const client = this.client
    this.client = null
    if (client) await client.close().catch(() => undefined)
    if (!this.deps.channel) await this.stopChrome()
  }

  close(): Promise<void> {
    return this.shutdown(true)
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(
      () => void this.shutdown(false).catch(() => undefined),
      this.deps.idleMs ?? 10 * 60_000,
    )
    this.idleTimer.unref?.()
  }

  /** Runs a job on a fresh tab, one at a time; a broken connection is reopened once. */
  private run<T>(job: (client: CdpClient, sessionId: string) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      for (let attempt = 0; ; attempt++) {
        const client = await this.connect()
        let targetId: string | null = null
        try {
          targetId = (await client.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' }))
            .targetId
          const { sessionId } = await client.send<{ sessionId: string }>('Target.attachToTarget', {
            targetId,
            flatten: true,
          })
          return await job(client, sessionId)
        } catch (err) {
          if (!(err instanceof CdpError) || !client.closed || attempt > 0) throw err
        } finally {
          if (targetId && !client.closed)
            await client.send('Target.closeTarget', { targetId }).catch(() => undefined)
          this.touch()
        }
      }
    })
    this.queue = next.catch(() => undefined)
    return next
  }

  private evaluate<T>(client: CdpClient, sessionId: string, expression: string, timeoutMs = 30_000) {
    return client.evaluate<T>(expression, sessionId, { awaitPromise: true, timeoutMs })
  }

  private async load(client: CdpClient, sessionId: string, url: string): Promise<void> {
    const nav = await client.send<{ errorText?: string }>('Page.navigate', { url }, sessionId)
    if (nav.errorText) throw new Error(`could not load the frame (${nav.errorText})`)
    const deadline = Date.now() + 20_000
    for (;;) {
      const state = await this.evaluate<string>(
        client,
        sessionId,
        `location.href === ${JSON.stringify(url)} ? document.readyState : 'loading'`,
      ).catch(() => 'loading')
      if (state === 'complete') return
      if (Date.now() > deadline) throw new Error('the frame took too long to load')
      await sleep(50)
    }
  }

  render(request: RenderRequest): Promise<RenderResult> {
    return this.run(async (client, sessionId) => {
      const metrics = (height: number) =>
        client.send(
          'Emulation.setDeviceMetricsOverride',
          { width: request.width, height, deviceScaleFactor: request.scale, mobile: false },
          sessionId,
        )
      await metrics(request.height ?? 800)
      await this.load(client, sessionId, request.url)
      const inspected = await this.evaluate<{
        height: number
        contentHeight: number
        problems: DesignProblem[]
        outline: string[]
      }>(client, sessionId, `(${INSPECT_SCRIPT})(${request.width}, ${request.height ?? 0})`)
      const height = Math.max(1, Math.round(request.height ?? inspected.height))
      let png: Uint8Array | null = null
      if (request.screenshot) {
        if (request.height === null) await metrics(height)
        const shot = await client.send<{ data: string }>(
          'Page.captureScreenshot',
          { format: 'png', clip: { x: 0, y: 0, width: request.width, height, scale: 1 } },
          sessionId,
          90_000,
        )
        png = Buffer.from(shot.data, 'base64')
      }
      return {
        height,
        contentHeight: inspected.contentHeight,
        problems: inspected.problems,
        outline: inspected.outline,
        png,
      }
    })
  }

  pdf(url: string): Promise<Uint8Array> {
    return this.run(async (client, sessionId) => {
      await this.load(client, sessionId, url)
      await this.evaluate(client, sessionId, PRINT_PREPARE_SCRIPT, 60_000)
      const { stream } = await client.send<{ stream: string }>(
        'Page.printToPDF',
        {
          printBackground: true,
          preferCSSPageSize: true,
          transferMode: 'ReturnAsStream',
          marginTop: 0,
          marginBottom: 0,
          marginLeft: 0,
          marginRight: 0,
        },
        sessionId,
        120_000,
      )
      const chunks: Buffer[] = []
      try {
        for (;;) {
          const part = await client.send<{ data: string; base64Encoded?: boolean; eof: boolean }>(
            'IO.read',
            { handle: stream, size: 1024 * 1024 },
            sessionId,
          )
          chunks.push(Buffer.from(part.data, part.base64Encoded ? 'base64' : 'utf8'))
          if (part.eof) break
        }
      } finally {
        await client.send('IO.close', { handle: stream }, sessionId).catch(() => undefined)
      }
      return new Uint8Array(Buffer.concat(chunks))
    })
  }
}
