#!/usr/bin/env node
// Renders the macOS DMG window background (build/dmg-background.png and @2x) with the renderer's
// DmgBackground (also at `#/dev/dmg-background` in the dev app), so the bots are drawn by the app's own BotAvatar.
// The page is served alone, without the app's boot (which needs the preload bridge).
//   --mock <dir>   also writes Finder-like previews with the icons and their labels (macOS only)
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createServer, loadConfigFromFile } from 'vite'

import { DMG_LAYOUT } from '../../../../scripts/package/config.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const desktop = join(here, '..', '..')
const build = join(desktop, 'build')

const mockArg = process.argv.indexOf('--mock')
const mockDir = mockArg > 0 ? resolve(process.argv[mockArg + 1] ?? '') : null

const APPLICATIONS_ICON =
  '/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/ApplicationsFolderIcon.icns'

function dataUrl(file, type) {
  return `data:${type};base64,${readFileSync(file).toString('base64')}`
}

/** The icons Finder draws over the background, for the previews only. */
function mockIcons(work) {
  const folder = join(work, 'applications.png')
  const converted = spawnSync(
    'sips',
    ['-s', 'format', 'png', '-Z', '256', APPLICATIONS_ICON, '--out', folder],
    {
      stdio: 'ignore',
      windowsHide: true,
    },
  )
  if (converted.status !== 0) throw new Error('could not convert the Applications folder icon')
  return {
    app: dataUrl(join(build, 'icon.svg'), 'image/svg+xml'),
    applications: dataUrl(folder, 'image/png'),
  }
}

const PAGE = '/dmg-background.html'
const ENTRY = 'virtual:dmg-background'

/** A page that renders only DmgBackground, with the app's theme tokens. */
const standalonePage = {
  name: 'dmg-background-page',
  resolveId: (id) => (id === ENTRY ? `\0${ENTRY}` : null),
  load(id) {
    if (id !== `\0${ENTRY}`) return null
    return [
      `import '@/styles.css'`,
      `import { createElement } from 'react'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { DmgBackground } from '@/features/setup/DmgBackground'`,
      `createRoot(document.getElementById('root')).render(createElement(DmgBackground, { params: new URLSearchParams(location.search) }))`,
    ].join('\n')
  },
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url?.split('?')[0] !== PAGE) return next()
      const html = await server.transformIndexHtml(
        req.url,
        `<!doctype html><html><head><meta charset="UTF-8" /></head><body><div id="root"></div><script type="module" src="/@id/${ENTRY}"></script></body></html>`,
      )
      res.setHeader('Content-Type', 'text/html')
      res.end(html)
    })
  },
}

const loaded = await loadConfigFromFile(
  { command: 'serve', mode: 'development' },
  join(desktop, 'electron.vite.config.ts'),
)
if (!loaded) throw new Error('electron.vite.config.ts not found')
const server = await createServer({
  ...loaded.config.renderer,
  plugins: [...(loaded.config.renderer.plugins ?? []), standalonePage],
  configFile: false,
  logLevel: 'warn',
  server: { host: '127.0.0.1', strictPort: false },
})
const work = mkdtempSync(join(tmpdir(), 'milibot-dmg-background-'))
try {
  await server.listen()
  const base = server.resolvedUrls?.local[0]
  if (!base) throw new Error('vite did not report its URL')
  const query = new URLSearchParams({
    width: String(DMG_LAYOUT.width),
    height: String(DMG_LAYOUT.height),
    chrome: String(DMG_LAYOUT.finderChrome),
    iconSize: String(DMG_LAYOUT.iconSize),
    app: DMG_LAYOUT.app.join(','),
    applications: DMG_LAYOUT.applications.join(','),
  })
  const shots = [
    { scale: 1, file: join(build, 'dmg-background.png') },
    { scale: 2, file: join(build, 'dmg-background@2x.png') },
  ]
  if (mockDir) {
    mkdirSync(mockDir, { recursive: true })
    const icons = mockIcons(work)
    shots.push(
      { scale: 2, file: join(mockDir, 'finder-mock-dark.png'), mock: { ...icons, labelColor: '#ffffff' } },
      { scale: 2, file: join(mockDir, 'finder-mock-light.png'), mock: { ...icons, labelColor: '#000000' } },
    )
  }
  const job = {
    url: `${new URL(PAGE, base)}?${query}`,
    width: DMG_LAYOUT.width,
    height: DMG_LAYOUT.height + DMG_LAYOUT.finderChrome,
    layout: DMG_LAYOUT,
    shots,
  }
  const jobFile = join(work, 'job.json')
  writeFileSync(jobFile, JSON.stringify(job))
  const electron = createRequire(join(desktop, 'package.json'))('electron')
  const code = await new Promise((done, fail) => {
    const child = spawn(electron, [join(here, 'capture.mjs'), jobFile], {
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
    })
    child.on('error', fail)
    child.on('exit', (status) => done(status ?? 1))
  })
  if (code !== 0) throw new Error(`capture exited with ${code}`)
  for (const shot of shots) console.log(`dmg-background: wrote ${shot.file}`)
} finally {
  await server.close()
  rmSync(work, { recursive: true, force: true })
}
