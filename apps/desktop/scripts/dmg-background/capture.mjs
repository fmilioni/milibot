// Electron main for index.mjs: loads the page offscreen and writes each requested PNG.
import { readFileSync, writeFileSync } from 'node:fs'

import { app, BrowserWindow } from 'electron'

const job = JSON.parse(readFileSync(process.argv.at(-1) ?? '', 'utf8'))

/** Finder's icon view: the label sits under the icon in the system font at the DMG's text size (12). */
function mockScript({ app: appIcon, applications, labelColor }, layout) {
  const items = [
    { src: appIcon, name: 'Milibot', at: layout.app },
    { src: applications, name: 'Applications', at: layout.applications },
  ]
  return `(() => {
    const root = document.querySelector('[data-dmg-ready]')
    root.querySelectorAll('[data-mock]').forEach((el) => el.remove())
    for (const item of ${JSON.stringify(items)}) {
      const size = ${layout.iconSize}
      const img = document.createElement('img')
      img.dataset.mock = ''
      img.src = item.src
      Object.assign(img.style, { position: 'absolute', width: size + 'px', height: size + 'px',
        left: item.at[0] - size / 2 + 'px', top: item.at[1] - size / 2 + 'px' })
      const label = document.createElement('div')
      label.dataset.mock = ''
      label.textContent = item.name
      Object.assign(label.style, { position: 'absolute', width: '160px', textAlign: 'center',
        left: item.at[0] - 80 + 'px', top: item.at[1] + size / 2 + 3 + 'px',
        font: '12px -apple-system, system-ui', lineHeight: '15px', color: ${JSON.stringify(labelColor)} })
      root.append(img, label)
    }
    return Promise.all([...document.images].map((img) => img.decode().catch(() => null)))
  })()`
}

const READY_SCRIPT = String.raw`
new Promise((resolve, reject) => {
  const started = Date.now()
  const poll = () => {
    if (document.querySelector('[data-dmg-ready]')) return document.fonts.ready.then(() => resolve(true))
    if (Date.now() - started > 30000) return reject(new Error('the dmg-background page did not render'))
    setTimeout(poll, 50)
  }
  poll()
})
`

async function run() {
  const window = new BrowserWindow({
    show: false,
    width: job.width,
    height: job.height,
    useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  })
  const wc = window.webContents
  wc.on('console-message', ({ level, message }) => {
    if (level === 'error' || level === 'warning') console.error(`page: ${message}`)
  })
  try {
    await window.loadURL(job.url)
    await wc.executeJavaScript(READY_SCRIPT, true)
    wc.debugger.attach('1.3')
    for (const shot of job.shots) {
      await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: job.width,
        height: job.height,
        deviceScaleFactor: shot.scale,
        mobile: false,
      })
      await wc.executeJavaScript(
        shot.mock
          ? mockScript(shot.mock, job.layout)
          : `document.querySelectorAll('[data-mock]').forEach((el) => el.remove())`,
        true,
      )
      const { data } = await wc.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png',
        clip: { x: 0, y: 0, width: job.width, height: job.height, scale: 1 },
      })
      writeFileSync(shot.file, Buffer.from(data, 'base64'))
    }
    wc.debugger.detach()
  } finally {
    window.destroy()
  }
}

app.dock?.hide()
// No top-level await: Electron holds `ready` until the main module has finished evaluating.
app
  .whenReady()
  .then(run)
  .then(
    () => app.quit(),
    (error) => {
      console.error(error)
      app.exit(1)
    },
  )
