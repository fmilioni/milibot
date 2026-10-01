import { rename, rm } from 'node:fs/promises'

import { sha256Hex } from '@milibot/agent/llm'
import {
  DESIGN_FILE_FORMAT,
  DESIGN_FILE_VERSION,
  DESIGN_LIMITS,
  DesignFileContent,
  DesignFileManifest,
  slugify,
} from '@milibot/shared'

import { DaemonError } from '../../errors'
import { ZipFormatError, ZipReader, ZipWriter } from '../../util/zip'
import { FONT_FAMILY_PATTERN } from './fonts'
import { artInfo, type DesignRow, type FrameRow, lookOf } from './store'
import { applyTokenChanges, checkThemes, DesignInputError, findTheme } from './tokens'

const MANIFEST = 'manifest.json'
const CONTENT = 'design.json'
const MAX_CONTENT_BYTES = 2 * 1024 * 1024
const MAX_ASSET_BYTES = 10 * 1024 * 1024
const MAX_ASSETS_BYTES = 200 * 1024 * 1024
const ASSET_PATTERN = /asset:([0-9a-f]{64})/g

/** Blob shas a frame source references as `asset:<sha>`. */
function assetShas(...texts: Array<string | null>): Set<string> {
  const shas = new Set<string>()
  for (const text of texts) if (text) for (const m of text.matchAll(ASSET_PATTERN)) shas.add(m[1] as string)
  return shas
}

/** A `.mbdesign` read back: the look, the frames' sources and the images they reference. */
export interface DesignBundle {
  content: DesignFileContent
  sources: Array<{ html: string; css: string }>
  assets: Map<string, Uint8Array>
}

function frameFile(index: number, name: string): string {
  return `${index + 1}-${slugify(name, { maxLength: 30, fallback: 'frame' })}`
}

export async function writeDesignBundle(
  path: string,
  design: DesignRow,
  frames: readonly FrameRow[],
  readAsset: (sha: string) => Promise<Uint8Array | null>,
  now: number,
): Promise<void> {
  const look = lookOf(design)
  const files = frames.map((f, i) => frameFile(i, f.name))
  const content: DesignFileContent = {
    name: look.name,
    themes: look.themes,
    tokens: look.tokens,
    fonts: look.fonts,
    frames: frames.map((f, i) => ({
      file: files[i] as string,
      name: f.name,
      x: f.x,
      y: f.y,
      width: f.width,
      height: f.height,
      theme: f.theme,
      ...(f.art_status && assetShas(f.html).size ? { art: { prompt: artInfo(f)?.prompt ?? '' } } : {}),
    })),
  }
  const manifest: DesignFileManifest = {
    format: DESIGN_FILE_FORMAT,
    formatVersion: DESIGN_FILE_VERSION,
    exportedAt: now,
  }
  const partial = `${path}.partial`
  const zip = await ZipWriter.create(partial)
  try {
    await zip.addBuffer(MANIFEST, JSON.stringify(manifest, null, 2), { deflate: true })
    await zip.addBuffer(CONTENT, JSON.stringify(content, null, 2), { deflate: true })
    for (const [i, frame] of frames.entries()) {
      await zip.addBuffer(`frames/${files[i]}.html`, frame.html, { deflate: true })
      if (frame.css) await zip.addBuffer(`frames/${files[i]}.css`, frame.css, { deflate: true })
    }
    for (const sha of assetShas(...frames.flatMap((f) => [f.html, f.css]))) {
      const bytes = await readAsset(sha)
      if (bytes) await zip.addBuffer(`assets/${sha}`, Buffer.from(bytes))
    }
    await zip.finish()
    await rename(partial, path)
  } catch (err) {
    await zip.abort().catch(() => undefined)
    await rm(partial, { force: true })
    throw err
  }
}

function invalid(message: string): DaemonError {
  return new DaemonError('validation_failed', `Not a design file: ${message}`, {
    reason: 'design_file_invalid',
  })
}

function parseJsonEntry(data: Buffer, name: string): unknown {
  try {
    return JSON.parse(data.toString('utf8'))
  } catch {
    throw invalid(`${name} is not JSON`)
  }
}

export async function readDesignBundle(path: string): Promise<DesignBundle> {
  let reader: ZipReader
  try {
    reader = await ZipReader.open(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      throw new DaemonError('validation_failed', `File not found: ${path}`, { reason: 'file_missing' })
    throw invalid('not a zip file')
  }
  try {
    const manifest = DesignFileManifest.safeParse(
      parseJsonEntry(await reader.read(MANIFEST, { maxBytes: 64 * 1024 }), MANIFEST),
    )
    if (!manifest.success) throw invalid('bad manifest')
    if (manifest.data.formatVersion > DESIGN_FILE_VERSION)
      throw new DaemonError('validation_failed', 'The design file was made by a newer Milibot', {
        reason: 'design_file_too_new',
      })
    const parsed = DesignFileContent.safeParse(
      parseJsonEntry(await reader.read(CONTENT, { maxBytes: MAX_CONTENT_BYTES }), CONTENT),
    )
    if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'bad design.json')
    let content: DesignFileContent
    try {
      const themes = checkThemes(parsed.data.themes)
      const { tokens } = applyTokenChanges(
        [],
        parsed.data.tokens.map((t) => ({
          name: t.name,
          type: t.type,
          ...(t.value !== null ? { value: t.value } : {}),
          ...(Object.keys(t.values).length ? { values: t.values } : {}),
        })),
        themes,
      )
      const frames = parsed.data.frames.map((f) => ({
        ...f,
        theme: f.theme ? findTheme(themes, f.theme) : null,
      }))
      content = { ...parsed.data, themes, tokens, frames }
    } catch (err) {
      if (err instanceof DesignInputError) throw invalid(err.message)
      throw err
    }
    for (const family of content.fonts)
      if (!FONT_FAMILY_PATTERN.test(family)) throw invalid(`"${family}" is not a font family name`)
    if (new Set(content.frames.map((f) => f.file)).size !== content.frames.length)
      throw invalid('two frames share a file')

    const sources: DesignBundle['sources'] = []
    for (const frame of content.frames) {
      const html = await reader.read(`frames/${frame.file}.html`, { maxBytes: DESIGN_LIMITS.frameHtmlBytes })
      const cssName = `frames/${frame.file}.css`
      const css = reader.entry(cssName)
        ? await reader.read(cssName, { maxBytes: DESIGN_LIMITS.frameCssBytes })
        : Buffer.alloc(0)
      sources.push({ html: html.toString('utf8'), css: css.toString('utf8') })
    }

    const assets = new Map<string, Uint8Array>()
    let total = 0
    for (const sha of assetShas(...sources.flatMap((s) => [s.html, s.css]))) {
      if (!reader.entry(`assets/${sha}`)) continue
      const bytes = await reader.read(`assets/${sha}`, { maxBytes: MAX_ASSET_BYTES })
      total += bytes.length
      if (total > MAX_ASSETS_BYTES) throw invalid('the images are too large')
      if (sha256Hex(bytes) !== sha) throw invalid(`the image ${sha} is corrupted`)
      assets.set(sha, bytes)
    }
    return { content, sources, assets }
  } catch (err) {
    if (err instanceof ZipFormatError) throw invalid(err.message)
    throw err
  }
}
