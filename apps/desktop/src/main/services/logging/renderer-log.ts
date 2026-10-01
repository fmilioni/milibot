import type { RendererErrorReport } from '../../../bridge/contract'
import { appPaths } from '../../daemon/paths'
import { windowLabel } from '../../windows/registry'
import { appendRotating, formatLogEntry } from './log-file'

const MAX_LOG_BYTES = 2 * 1024 * 1024

function write(webContentsId: number, title: string, details: Array<string | undefined>): void {
  const entry = formatLogEntry(new Date(), windowLabel(webContentsId), title, details)
  console.error(`[renderer] ${entry.trimEnd()}`)
  try {
    appendRotating(appPaths().rendererLog, entry, MAX_LOG_BYTES)
  } catch (err) {
    console.error('[renderer] could not write the log', err)
  }
}

export function logRendererError(webContentsId: number, report: RendererErrorReport): void {
  const where = report.area ? ` in ${report.area}` : ''
  write(webContentsId, `${report.source}${where}: ${report.message}`, [report.stack, report.componentStack])
}

export function logWindowEvent(webContentsId: number, text: string): void {
  write(webContentsId, text, [])
}
