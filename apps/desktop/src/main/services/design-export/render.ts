import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PRINT_PREPARE_SCRIPT } from '@milibot/shared'
import { BrowserWindow } from 'electron'

import type { DesignExportFrame } from '../../../bridge/contract'
import { exportScale, framesPrintDocument } from './logic'

/** Waits for a frame page's fonts and images and returns its content height. */
const MEASURE_SCRIPT = String.raw`
(async () => {
  await document.fonts.ready
  await Promise.all([...document.images].map((img) => img.complete ? null : new Promise((r) => { img.onload = img.onerror = r })))
  return Math.ceil(Math.max(document.body.scrollHeight, document.documentElement.scrollHeight))
})()
`

const LOAD_TIMEOUT_MS = 30_000

/**
 * Loads a page in a hidden offscreen window (it paints without being on screen) from a temporary file:
 * frame pages embed their fonts, too large for a data: URL.
 */
async function withPage<T>(
  html: string,
  size: { width: number; height: number },
  run: (window: BrowserWindow) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'milibot-design-export-'))
  const file = join(dir, 'page.html')
  let window: BrowserWindow | null = null
  try {
    await writeFile(file, html, 'utf8')
    window = new BrowserWindow({
      show: false,
      width: Math.max(16, Math.round(size.width)),
      height: Math.max(16, Math.round(size.height)),
      useContentSize: true,
      webPreferences: {
        offscreen: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    await Promise.race([
      window.loadFile(file),
      new Promise((_, reject) => setTimeout(() => reject(new Error('page load timed out')), LOAD_TIMEOUT_MS)),
    ])
    return await run(window)
  } finally {
    window?.destroy()
    await rm(dir, { recursive: true, force: true })
  }
}

/** A frame as PNG at `scale` (lowered if the image would pass Chromium's size limits). */
export async function renderFramePng(
  frame: DesignExportFrame,
  requestedScale: number,
): Promise<{ png: Buffer; width: number; height: number; scale: number }> {
  return withPage(frame.html, { width: frame.width, height: frame.height ?? 800 }, async (window) => {
    const wc = window.webContents
    wc.debugger.attach('1.3')
    try {
      const send = <T>(method: string, params: Record<string, unknown> = {}) =>
        wc.debugger.sendCommand(method, params) as Promise<T>
      await send('Emulation.setDeviceMetricsOverride', {
        width: frame.width,
        height: frame.height ?? 800,
        deviceScaleFactor: 1,
        mobile: false,
      })
      const measured = (await wc.executeJavaScript(MEASURE_SCRIPT, true)) as number
      const height = frame.height ?? Math.max(1, measured)
      const scale = exportScale(frame.width, height, requestedScale)
      await send('Emulation.setDeviceMetricsOverride', {
        width: frame.width,
        height,
        deviceScaleFactor: scale,
        mobile: false,
      })
      const shot = await send<{ data: string }>('Page.captureScreenshot', {
        format: 'png',
        clip: { x: 0, y: 0, width: frame.width, height, scale: 1 },
        captureBeyondViewport: true,
      })
      return { png: Buffer.from(shot.data, 'base64'), width: frame.width, height, scale }
    } finally {
      wc.debugger.detach()
    }
  })
}

/** Frames as one PDF, a page per frame at the frame's size. */
export async function renderFramesPdf(frames: readonly DesignExportFrame[]): Promise<Buffer> {
  const first = frames[0]
  if (!first) throw new Error('no frames')
  return withPage(
    framesPrintDocument(frames),
    { width: first.width, height: first.height ?? 1000 },
    async (window) => {
      await window.webContents.executeJavaScript(PRINT_PREPARE_SCRIPT, true)
      return window.webContents.printToPDF({
        printBackground: true,
        preferCSSPageSize: true,
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
      })
    },
  )
}
