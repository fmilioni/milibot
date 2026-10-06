import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { app } from 'electron'
import { AppImageUpdater, DebUpdater, type Logger, MacUpdater, NsisUpdater } from 'electron-updater'

import { appPaths } from '../daemon/paths'
import { appendRotating } from '../services/logging/log-file'
import type { UpdaterEngine } from './app-updater'
import { type InstallKind, installKind } from './install-kind'

const MAX_LOG_BYTES = 2 * 1024 * 1024

/** Replaces the feed of app-update.yml (a local server in tests); read only when set. */
const FEED_URL_ENV = 'MILIBOT_UPDATE_FEED_URL'

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function buildAllows(): boolean {
  const text = readText(join(app.getAppPath(), 'package.json'))
  if (!text) return false
  try {
    return (JSON.parse(text) as { milibot?: { autoUpdate?: unknown } }).milibot?.autoUpdate === true
  } catch {
    return false
  }
}

/** Appends to `logs/updater.log` (and the console). */
export function logUpdate(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`
  console.log(`[update] ${message}`)
  try {
    appendRotating(join(appPaths().logsDir, 'updater.log'), line, MAX_LOG_BYTES)
  } catch {
    // The log is a convenience: never let it stop an update.
  }
}

const logger: Logger = {
  info: (message: unknown) => logUpdate(String(message)),
  warn: (message: unknown) => logUpdate(`warn: ${String(message)}`),
  error: (message: unknown) => logUpdate(`error: ${String(message)}`),
}

function create(kind: InstallKind) {
  switch (kind) {
    case 'mac':
      return new MacUpdater()
    case 'nsis':
      return new NsisUpdater()
    case 'appimage':
      return new AppImageUpdater()
    case 'deb':
      return new DebUpdater()
  }
}

/** The updater for this install, or null when it cannot update itself. */
export function createUpdaterEngine(): UpdaterEngine | null {
  const kind = installKind({
    platform: process.platform,
    packaged: app.isPackaged,
    buildAllows: app.isPackaged && buildAllows(),
    appImage: process.env.APPIMAGE,
    packageType: app.isPackaged
      ? (readText(join(process.resourcesPath, 'package-type'))?.trim() ?? null)
      : null,
  })
  if (!kind) return null
  const engine = create(kind)
  engine.logger = logger
  const feed = process.env[FEED_URL_ENV]
  if (feed) engine.setFeedURL({ provider: 'generic', url: feed })
  logUpdate(`${kind} updater on ${app.getVersion()}${feed ? `, feed ${feed}` : ''}`)
  return engine
}
