import { posix } from 'node:path'

import type { ContentPart } from '@milibot/agent/llm'
import type { Bot } from '@milibot/shared'

import { botLinuxUser, type VmController } from '../vm'
import { fileSlug, problemLines } from './format'
import type { DesignHost } from './host'
import { assetRefs, sourceDocument } from './html'
import { AUTO_HEIGHT_GUESS, type DesignRow, type FrameRow, lookOf } from './store'
import { tokensCss } from './tokens'

const MAX_SCREENSHOT_PIXELS = 16_000_000

export type ExportFormat = 'png' | 'pdf' | 'html'

export interface DesignOutputDeps {
  host: DesignHost
  vm: Pick<VmController, 'guest'>
  blobs: {
    put(bytes: Uint8Array, mediaType: string): Promise<string>
    get(sha: string): Promise<{ bytes: Uint8Array }>
  }
}

/** Screenshots for bots, and exports written into the VM as the bot. */
export class DesignOutput {
  constructor(private readonly deps: DesignOutputDeps) {}

  async screenshot(
    design: DesignRow,
    frame: FrameRow,
    theme: string | null,
    scale: number,
  ): Promise<ContentPart[]> {
    const { host } = this.deps
    const compiled = await host.compileRow(design, frame, theme)
    const height = frame.height ?? frame.measured_height ?? AUTO_HEIGHT_GUESS
    const fit = Math.min(scale, Math.sqrt(MAX_SCREENSHOT_PIXELS / (frame.width * height)))
    const result = await host.render.render({
      url: await host.frameUrl(design.id, frame.id, theme),
      width: frame.width,
      height: frame.height,
      scale: fit,
      screenshot: true,
    })
    if (frame.height === null && result.height !== frame.measured_height)
      host.store.setMeasuredHeight(frame.id, result.height)
    const problems = [...compiled.problems, ...result.problems]
    const drawing =
      frame.art_status === 'drawing'
        ? "\nStill being drawn: this shows the previous drawing or nothing. Don't check it again; a later design tool result says when it is done."
        : ''
    const content: ContentPart[] = [
      {
        type: 'text',
        text: `"${frame.name}" ${frame.width}×${result.height} · theme ${compiled.theme}\n${problemLines(problems)}${drawing}`,
      },
    ]
    if (result.png) {
      const sha = await this.deps.blobs.put(result.png, 'image/png')
      content.push({
        type: 'image',
        sha256: sha,
        mediaType: 'image/png',
        width: Math.round(frame.width * fit),
        height: Math.round(result.height * fit),
        placeholder: `[screenshot of the frame "${frame.name}" removed from the context]`,
      })
    }
    return content
  }

  /** Writes the frames at `path` (a file or a folder under /workspace) as the bot; returns the files written. */
  async export(
    bot: Bot,
    design: DesignRow,
    frames: readonly FrameRow[],
    format: ExportFormat,
    path: string,
    scale: number,
  ): Promise<string[]> {
    const { host } = this.deps
    const written: string[] = []
    const write = async (file: string, data: Uint8Array | string) => {
      const guest = await this.deps.vm.guest()
      await guest.fsWriteAll(file, data, { owner: botLinuxUser(bot.slug) })
      written.push(file)
    }
    const fileName = (frame: FrameRow, i: number, ext: string) =>
      `${String(i + 1).padStart(2, '0')}-${fileSlug(frame.name)}.${ext}`
    if (format === 'pdf') {
      const file = path.endsWith('.pdf') ? path : posix.join(path, `${fileSlug(design.name)}.pdf`)
      await write(
        file,
        await host.render.pdf(
          await host.printUrl(
            design.id,
            frames.map((f) => f.id),
          ),
        ),
      )
    } else if (format === 'png') {
      const single = frames.length === 1 && path.endsWith('.png')
      for (const [i, frame] of frames.entries()) {
        const height = frame.height ?? frame.measured_height ?? AUTO_HEIGHT_GUESS
        const fit = Math.min(scale, Math.sqrt((MAX_SCREENSHOT_PIXELS * 2) / (frame.width * height)))
        const result = await host.render.render({
          url: await host.frameUrl(design.id, frame.id, null),
          width: frame.width,
          height: frame.height,
          scale: fit,
          screenshot: true,
        })
        if (!result.png) continue
        await write(
          single ? path : posix.join(path.replace(/\.png$/, ''), fileName(frame, i, 'png')),
          result.png,
        )
      }
    } else {
      const look = lookOf(design)
      const dir = path.endsWith('.html') ? posix.dirname(path) : path
      await write(posix.join(dir, 'tokens.css'), tokensCss(design.name, look.tokens, look.themes))
      for (const [i, frame] of frames.entries()) {
        const base =
          frames.length === 1 && path.endsWith('.html')
            ? posix.basename(path, '.html')
            : fileName(frame, i, 'html').replace(/\.html$/, '')
        const compiled = await host.compileRow(design, frame)
        await write(posix.join(dir, `${base}.html`), compiled.html)
        await write(posix.join(dir, `${base}.source.html`), sourceDocument(design, frame, compiled.theme))
      }
      for (const art of host.store.frames(design.id)) {
        const sha = art.art_status ? assetRefs(art.html)[0] : undefined
        if (!sha) continue
        await write(
          posix.join(dir, 'art', `${fileSlug(art.name)}.svg`),
          (await this.deps.blobs.get(sha)).bytes,
        )
      }
    }
    return written
  }
}
