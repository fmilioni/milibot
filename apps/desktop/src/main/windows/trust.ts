import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Where the app's own page is served: the Vite dev server (`ELECTRON_RENDERER_URL`) or the packaged file. */
export interface RendererLocation {
  devUrl?: string
  indexFile: string
}

let location: RendererLocation | null = null

export function rendererLocation(): RendererLocation {
  location ??= {
    devUrl: process.env.ELECTRON_RENDERER_URL || undefined,
    indexFile: join(__dirname, '../renderer/index.html'),
  }
  return location
}

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/** Whether `url` is the app's own page (any hash or query): same origin as the dev server, or the index file. */
export function isAppUrl(url: string, where: RendererLocation): boolean {
  const target = parse(url)
  if (!target) return false
  if (where.devUrl) {
    const dev = parse(where.devUrl)
    return dev !== null && dev.origin !== 'null' && target.origin === dev.origin
  }
  const index = pathToFileURL(where.indexFile)
  return target.protocol === 'file:' && target.host === index.host && target.pathname === index.pathname
}

export interface IpcSender {
  webContentsId: number
  /** URL of the frame that sent the message; null when it is gone. */
  frameUrl: string | null
  topFrame: boolean
}

/** IPC is served only to the top frame of an app window showing the app's own page. */
export function isTrustedSender(
  sender: IpcSender,
  where: RendererLocation,
  isAppWindow: (webContentsId: number) => boolean,
): boolean {
  return (
    sender.topFrame &&
    sender.frameUrl !== null &&
    isAppWindow(sender.webContentsId) &&
    isAppUrl(sender.frameUrl, where)
  )
}
