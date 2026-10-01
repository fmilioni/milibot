import { writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

import { DESIGN_FILE_EXTENSION } from '@milibot/shared'
import { clipboard, ClipboardItem, type WebContents } from 'electron'
import { strToU8, type Zippable, zipSync } from 'fflate'

import type { DesignSaveOptions } from '../../bridge/contract'
import { exportFileName, uniqueBaseNames } from '../services/design-export/logic'
import { renderFramePng, renderFramesPdf } from '../services/design-export/render'
import { saveDialog } from './dialogs'
import type { InvokeHandlers } from './handle'

/** Save panel for an export; null when cancelled. */
function askSavePath(
  sender: WebContents,
  save: DesignSaveOptions,
  extension: string,
): Promise<string | null> {
  return saveDialog(sender, {
    title: save.title,
    fileName: exportFileName(save.defaultName, extension),
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
  })
}

export function designInvokes() {
  return {
    exportDesignPng: async (event, [frame, scale, save]) => {
      const path = await askSavePath(event.sender, save, 'png')
      if (!path) return null
      const image = await renderFramePng(frame, scale)
      await writeFile(path, image.png)
      return path
    },

    exportDesignPdf: async (event, [frames, save]) => {
      const path = await askSavePath(event.sender, save, 'pdf')
      if (!path) return null
      await writeFile(path, await renderFramesPdf(frames))
      return path
    },

    copyDesignImage: async (_event, [frame, scale]) => {
      const image = await renderFramePng(frame, scale)
      await clipboard.write([
        new ClipboardItem({ 'image/png': new Blob([new Uint8Array(image.png)], { type: 'image/png' }) }),
      ])
    },

    exportDesignPngZip: async (event, [frames, scale, save]) => {
      const path = await askSavePath(event.sender, save, 'zip')
      if (!path) return null
      const names = uniqueBaseNames(frames.map((f) => f.name))
      const files: Zippable = {}
      for (const [i, frame] of frames.entries())
        files[`${names[i]}.png`] = [(await renderFramePng(frame, scale)).png, { level: 0 }]
      await writeFile(path, zipSync(files))
      return path
    },

    saveDesignHtmlZip: async (event, [frames, save]) => {
      const path = await askSavePath(event.sender, save, 'zip')
      if (!path) return null
      const names = uniqueBaseNames(frames.map((f) => f.name))
      const files: Zippable = { 'tokens.css': strToU8(frames[0]?.tokensCss ?? '') }
      for (const [i, frame] of frames.entries()) {
        files[`${names[i]}.html`] = strToU8(frame.html)
        files[`${names[i]}.source.html`] = strToU8(frame.source)
      }
      await writeFile(path, zipSync(files))
      return path
    },

    chooseDesignFilePath: (event, [save]) => askSavePath(event.sender, save, DESIGN_FILE_EXTENSION),

    saveDesignHtml: async (event, [files, save]) => {
      const path = await askSavePath(event.sender, save, 'html')
      if (!path) return null
      const base = basename(path, extname(path))
      await writeFile(path, files.html, 'utf8')
      await writeFile(join(dirname(path), `${base}.source.html`), files.source, 'utf8')
      await writeFile(join(dirname(path), 'tokens.css'), files.tokensCss, 'utf8')
      return path
    },

    saveMarkdownFile: async (event, [text, save]) => {
      const path = await askSavePath(event.sender, save, 'md')
      if (!path) return null
      await writeFile(path, text, 'utf8')
      return path
    },
  } satisfies Partial<InvokeHandlers>
}
