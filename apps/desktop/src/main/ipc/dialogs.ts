import { join } from 'node:path'

import {
  app,
  BrowserWindow,
  dialog,
  type FileFilter,
  type OpenDialogOptions,
  type SaveDialogOptions,
  type WebContents,
} from 'electron'

/** Save panel over the calling window, starting in Downloads; the chosen path, or null when cancelled. */
export async function saveDialog(
  sender: WebContents,
  options: { title: string; fileName: string; filters?: FileFilter[] },
): Promise<string | null> {
  const window = BrowserWindow.fromWebContents(sender)
  const dialogOptions: SaveDialogOptions = {
    title: options.title,
    defaultPath: join(app.getPath('downloads'), options.fileName),
    filters: options.filters,
  }
  const result = window
    ? await dialog.showSaveDialog(window, dialogOptions)
    : await dialog.showSaveDialog(dialogOptions)
  return result.canceled || !result.filePath ? null : result.filePath
}

/**
 * Open panel over the calling window, starting in Downloads, for files with one of `extensions` (any
 * file when empty); `multiple` also allows folders and several picks. Empty when cancelled.
 */
export async function openDialog(
  sender: WebContents,
  options: { title: string; extensions: string[]; multiple: boolean },
): Promise<string[]> {
  const window = BrowserWindow.fromWebContents(sender)
  const { extensions } = options
  const dialogOptions: OpenDialogOptions = {
    title: options.title,
    defaultPath: app.getPath('downloads'),
    properties: options.multiple ? ['openFile', 'openDirectory', 'multiSelections'] : ['openFile'],
    filters: extensions.length ? [{ name: extensions.join(', '), extensions }] : undefined,
  }
  const result = window
    ? await dialog.showOpenDialog(window, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions)
  return result.canceled ? [] : result.filePaths
}
