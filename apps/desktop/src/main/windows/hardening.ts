import { app, shell } from 'electron'

import { isWebUrl } from '../../bridge/web-url'
import { isAppUrl, rendererLocation } from './trust'

/**
 * Every page the app creates (windows, the design export's offscreen page) stays on the app's own page:
 * navigations and redirects elsewhere (a dropped link, a stray `location` change) are cancelled, new
 * windows are refused (http(s) links open in the default browser) and `<webview>` never attaches.
 */
export function hardenWebContents(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (isWebUrl(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    const stayOnApp = (event: Electron.Event, url: string) => {
      if (!isAppUrl(url, rendererLocation())) event.preventDefault()
    }
    contents.on('will-navigate', stayOnApp)
    contents.on('will-redirect', stayOnApp)
    contents.on('will-attach-webview', (event) => event.preventDefault())
  })
}
