import { existsSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'

import { app, clipboard, shell } from 'electron'

import { mainText } from '../app/i18n'
import type { DaemonManager } from '../daemon/manager'
import { dataRoot } from '../daemon/paths'
import { isExportedFile, isRevealable, isSafeToOpen } from '../platform/host/open-path'
import { windowWorkspace } from '../windows/registry'
import { openDialog, saveDialog } from './dialogs'
import type { InvokeHandlers } from './handle'
import type { IpcDeps } from './register'

function assertExists(path: string): void {
  if (!existsSync(path)) throw new Error('Path not found')
}

/** Same folder the daemon reads the built-in skills from (`defaultBuiltinSkillsDir`). */
function builtinSkillsDir(): string {
  if (process.env.MILIBOT_BUILTIN_SKILLS) return process.env.MILIBOT_BUILTIN_SKILLS
  return app.isPackaged
    ? join(process.resourcesPath, 'assets', 'skills')
    : resolve(app.getAppPath(), '..', '..', 'packages', 'agent', 'skills')
}

/** The backup file the window's workspace last wrote (the user chose where, so it is outside every root). */
async function isBackupFile(daemon: DaemonManager, webContentsId: number, path: string): Promise<boolean> {
  const workspaceId = windowWorkspace(webContentsId)
  if (!workspaceId) return false
  const job = await (await daemon.client()).call('getBackupJob', { params: { workspaceId } })
  return job?.path === path
}

export function fileInvokes({ daemon, settings }: IpcDeps) {
  return {
    revealPath: async (event, [path]) => {
      const known =
        isRevealable(path, [dataRoot(), builtinSkillsDir()]) ||
        (await isBackupFile(daemon, event.sender.id, path))
      if (!known) throw new Error('Path not allowed')
      assertExists(path)
      shell.showItemInFolder(path)
    },

    chooseSavePath: (event, [{ defaultName, title, extension }]) =>
      saveDialog(event.sender, {
        title,
        fileName: defaultName,
        filters: [
          {
            name: mainText(settings.language, extension === 'zip' ? 'fileTypeZip' : 'fileTypeQemuDisk'),
            extensions: [extension],
          },
        ],
      }),

    saveFileAs: async (event, [{ sourcePath, defaultName, title }]) => {
      if (!isExportedFile(sourcePath)) throw new Error('Path not found')
      const fileName = defaultName || 'document'
      const ext = extname(fileName).slice(1)
      const path = await saveDialog(event.sender, {
        title,
        fileName,
        filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined,
      })
      if (path) await copyFile(sourcePath, path)
      return path
    },

    chooseOpenPath: async (event, [options]) => {
      const [path] = await openDialog(event.sender, { ...options, multiple: false })
      return path ?? null
    },

    chooseOpenPaths: (event, [options]) => openDialog(event.sender, { ...options, multiple: true }),

    readClipboard: () => clipboard.readText(),

    openPath: async (_event, [path]) => {
      if (!isExportedFile(path)) throw new Error('Path not found')
      if (!isSafeToOpen(path)) {
        shell.showItemInFolder(path)
        return
      }
      const error = await shell.openPath(path)
      if (error) throw new Error(error)
    },

    openExternal: async (_event, [url]) => {
      await shell.openExternal(url)
    },
  } satisfies Partial<InvokeHandlers>
}
