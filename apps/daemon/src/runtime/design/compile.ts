import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { DesignProblem, DesignToken } from '@milibot/shared'
import { compile } from 'tailwindcss'

import { errorMessage } from '../../errors'
import { sha256 } from '../../util/hash'
import { imageMediaType } from '../files'
import type { DesignAssets } from './assets'
import type { FontLibrary } from './fonts'
import { type ArtRef, assetRefs, inlineAssets, prepareFrameHtml, stripImports } from './html'
import { findTheme, fontFamilies, themeBlock } from './tokens'

/** Bumped when the compiled document changes shape (invalidates cached output). */
const COMPILER_VERSION = 1
const CACHE_ENTRIES = 64

const FRAME_CSP =
  "default-src 'none'; img-src data:; font-src data:; media-src data:; style-src 'unsafe-inline'"

export interface CompileDesign {
  name: string
  themes: readonly string[]
  tokens: readonly DesignToken[]
  fonts: readonly string[]
}

export interface CompileFrame {
  width: number
  /** Null: grows with the content. */
  height: number | null
  /** Drafts of screens: the body's least height while `height` is null. */
  minHeight?: number
  theme: string | null
  html: string
  css: string
  /** Resolved `data-art` targets (part of the cache key). */
  art?: Readonly<Record<string, ArtRef | null>>
}

export interface CompiledFrame {
  html: string
  theme: string
  problems: DesignProblem[]
}

export interface DesignAsset {
  bytes: Uint8Array
  mediaType: string
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Turns a frame into a self-contained HTML document: Tailwind v4 compiled in the daemon (class names read
 * from the HTML, no oxide scanner) with the design tokens of the frame's theme as `@theme` variables, fonts
 * and images as data: URIs, icons as inline SVG, no scripts (and a CSP that forbids them and any request).
 * The document's body is exactly the frame box. The same document renders in the VM's Chrome and in the app.
 */
export class DesignCompiler {
  private readonly cache = new Map<string, CompiledFrame>()
  private readonly stylesheets = new Map<string, string>()

  constructor(
    private readonly options: {
      assets: DesignAssets | null
      fonts: FontLibrary
      readAsset(sha: string): Promise<DesignAsset | null>
    },
  ) {}

  private stylesheet(id: string): { path: string; base: string; content: string } {
    const dir = this.options.assets?.tailwindDir
    if (!dir) throw new Error('the Tailwind stylesheets are missing from this installation')
    const name = id.replace(/^tailwindcss\/?/, '') || 'index.css'
    if (!/^(index|theme|preflight|utilities)(\.css)?$/.test(name)) throw new Error(`cannot import "${id}"`)
    const file = join(dir, name.endsWith('.css') ? name : `${name}.css`)
    let content = this.stylesheets.get(file)
    if (content === undefined) {
      content = readFileSync(file, 'utf8')
      this.stylesheets.set(file, content)
    }
    return { path: file, base: dir, content }
  }

  private async tailwind(input: string, candidates: string[]): Promise<string> {
    const compiler = await compile(input, {
      base: '/',
      loadStylesheet: async (id) => this.stylesheet(id),
    })
    return compiler.build(candidates)
  }

  async compile(
    design: CompileDesign,
    frame: CompileFrame,
    themeOverride?: string | null,
  ): Promise<CompiledFrame> {
    const theme =
      findTheme(design.themes, themeOverride ?? frame.theme ?? '') ?? design.themes[0] ?? 'default'
    const key = sha256(JSON.stringify([COMPILER_VERSION, design, frame, theme]))
    const cached = this.cache.get(key)
    if (cached) {
      this.cache.delete(key)
      this.cache.set(key, cached)
      return cached
    }
    const result = await this.build(design, frame, theme)
    this.cache.set(key, result)
    while (this.cache.size > CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value as string)
    return result
  }

  /** Same document, not cached (a frame still being written changes on every call). */
  async compileDraft(design: CompileDesign, frame: CompileFrame): Promise<CompiledFrame> {
    const theme = findTheme(design.themes, frame.theme ?? '') ?? design.themes[0] ?? 'default'
    return this.build(design, frame, theme)
  }

  /** A drawing in progress as a frame document (no Tailwind). */
  artDocument(svg: string, width: number, height: number): string {
    return [
      '<!doctype html>',
      '<html>',
      '<head>',
      '<meta charset="utf-8">',
      `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`,
      `<style>html,body{margin:0;padding:0}body{width:${width}px;height:${height}px;overflow:hidden}svg{display:block;width:100%;height:100%}</style>`,
      '</head>',
      `<body>${svg}</body>`,
      '</html>',
    ].join('\n')
  }

  private async build(design: CompileDesign, frame: CompileFrame, theme: string): Promise<CompiledFrame> {
    const prepared = prepareFrameHtml(frame.html, frame.art)
    const problems: DesignProblem[] = [...prepared.problems]
    const base = [
      '@layer theme, base, components, utilities;',
      '@import "tailwindcss/theme.css" layer(theme);',
      '@import "tailwindcss/preflight.css" layer(base);',
      '@import "tailwindcss/utilities.css" layer(utilities);',
      '@theme { --font-sans: "Inter", ui-sans-serif, system-ui, sans-serif; }',
      themeBlock(design.tokens, theme, design.themes),
    ].join('\n')
    const own = stripImports(frame.css)
    let css: string
    try {
      css = await this.tailwind(`${base}\n${own}`, prepared.candidates)
    } catch (err) {
      if (!own.trim()) throw err
      problems.push({
        kind: 'css_error',
        message: `The frame's CSS was left out: ${errorMessage(err)}`,
      })
      css = await this.tailwind(base, prepared.candidates)
    }

    const referenced = `${frame.html}\n${frame.css}`.toLowerCase()
    const tokenFonts = fontFamilies(design.tokens, theme, design.themes).map((f) => f.toLowerCase())
    const families = design.fonts.filter(
      (f) => tokenFonts.includes(f.toLowerCase()) || referenced.includes(f.toLowerCase()),
    )
    const fonts = await this.options.fonts.css(families, prepared.text)
    problems.push(...fonts.problems)

    const images = new Map<string, string>()
    for (const sha of assetRefs(prepared.html, css)) {
      const asset = await this.options.readAsset(sha)
      const type = asset ? (imageMediaType(asset.bytes, { svg: true }) ?? asset.mediaType) : null
      if (asset && type) images.set(sha, `data:${type};base64,${Buffer.from(asset.bytes).toString('base64')}`)
      else
        problems.push({ kind: 'asset_missing', message: `The image asset:${sha.slice(0, 12)}… is missing.` })
    }
    const resolve = (sha: string) => images.get(sha) ?? null

    const box = frame.height
      ? `width:${frame.width}px;height:${frame.height}px;overflow:hidden;`
      : `width:${frame.width}px;${frame.minHeight ? `min-height:${frame.minHeight}px;` : ''}overflow-x:hidden;`
    const html = [
      '<!doctype html>',
      `<html data-theme="${escapeHtml(theme)}">`,
      '<head>',
      '<meta charset="utf-8">',
      `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`,
      `<meta name="viewport" content="width=${frame.width}">`,
      `<title>${escapeHtml(design.name)}</title>`,
      fonts.css ? `<style>\n${fonts.css}\n</style>` : '',
      `<style>\n${inlineAssets(css, resolve)}\n</style>`,
      `<style>html,body{margin:0;padding:0}html{-webkit-print-color-adjust:exact;print-color-adjust:exact}body{${box}position:relative}</style>`,
      '</head>',
      `<body>${inlineAssets(prepared.html, resolve)}</body>`,
      '</html>',
    ]
      .filter(Boolean)
      .join('\n')
    return { html, theme, problems }
  }
}
