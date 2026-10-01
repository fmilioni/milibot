import type { DesignProblem } from '@milibot/shared'
import { type DefaultTreeAdapterTypes, parseFragment, serialize } from 'parse5'

import { iconSvg } from './icons'
import type { DesignRow, FrameRow } from './store'

type Element = DefaultTreeAdapterTypes.Element
type ParentNode = DefaultTreeAdapterTypes.ParentNode
type ChildNode = DefaultTreeAdapterTypes.ChildNode

/** Elements that could run code, load other documents or change the page's base: removed. */
const DROPPED = new Set([
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'portal',
  'base',
  'meta',
  'link',
  'noscript',
])
const URL_ATTRS = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'xlink:href',
  'poster',
  'background',
  'data',
])
const UNSAFE_URL = /^\s*(javascript|vbscript|data\s*:\s*text\/html)/i
const ASSET_REF = /asset:([0-9a-f]{64})/g

export type ArtRef =
  | { status: 'ready'; sha: string; width: number; height: number }
  | { status: 'drawing' | 'failed'; width: number; height: number }

export function artRefs(html: string): string[] {
  return [
    ...new Set([...html.matchAll(/\bdata-art\s*=\s*(["'])(.*?)\1/gs)].map((m) => (m[2] as string).trim())),
  ]
}

function artPlaceholder(width: number, height: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" rx="${Math.round(Math.min(width, height) / 12)}" fill="#a1a1aa" fill-opacity="0.25"/></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

export interface PreparedHtml {
  html: string
  /** Class names used (Tailwind candidates). */
  candidates: string[]
  /** All text, for picking font subsets. */
  text: string
  problems: DesignProblem[]
}

/** Blob shas referenced as `asset:<sha>` in a frame's HTML or CSS. */
export function assetRefs(...sources: string[]): string[] {
  const shas = new Set<string>()
  for (const source of sources) for (const m of source.matchAll(ASSET_REF)) shas.add(m[1] as string)
  return [...shas]
}

/** Replaces `asset:<sha>` references (resolved ones become data: URIs). */
export function inlineAssets(source: string, resolve: (sha: string) => string | null): string {
  return source.replace(ASSET_REF, (whole, sha: string) => resolve(sha) ?? whole)
}

function isElement(node: ChildNode | ParentNode): node is Element {
  return 'tagName' in node
}

function childrenOf(node: ParentNode): ChildNode[] {
  return node.childNodes
}

function attr(el: Element, name: string): string | null {
  return el.attrs.find((a) => a.name === name)?.value ?? null
}

/**
 * Makes a frame's HTML safe and ready to compile: no scripts, handlers, frames or external links;
 * `<i data-icon="lucide:name">` becomes inline SVG (an unknown icon becomes a dashed placeholder and a
 * problem). Collects the class names and the text.
 */
export function prepareFrameHtml(
  source: string,
  art: Readonly<Record<string, ArtRef | null>> = {},
): PreparedHtml {
  const fragment = parseFragment(source)
  const candidates = new Set<string>()
  const problems: DesignProblem[] = []
  const missingIcons = new Set<string>()
  const artProblems = new Map<string, DesignProblem>()
  const text: string[] = []

  const visit = (parent: ParentNode) => {
    const children = childrenOf(parent)
    for (let i = 0; i < children.length; i++) {
      const node = children[i] as ChildNode
      if (node.nodeName === '#text') {
        text.push((node as DefaultTreeAdapterTypes.TextNode).value)
        continue
      }
      if (!isElement(node)) continue
      const tag = node.tagName.toLowerCase()
      if (DROPPED.has(tag)) {
        children.splice(i--, 1)
        continue
      }
      node.attrs = node.attrs.filter((a) => {
        const name = a.name.toLowerCase()
        if (name.startsWith('on') || name === 'srcdoc') return false
        if (URL_ATTRS.has(name) && UNSAFE_URL.test(a.value)) return false
        if (name === 'style' && /url\(\s*['"]?\s*javascript:/i.test(a.value)) return false
        return true
      })
      const artName = attr(node, 'data-art')
      if (artName !== null) {
        const ref = art[artName.trim()] ?? null
        placeArt(node, ref)
        const name = artName.trim()
        if (!ref)
          artProblems.set(name, {
            kind: 'unknown_art',
            message: `There is no art frame "${name}" in this design (design_draw draws one); a neutral block stands in.`,
          })
        else if (ref.status === 'drawing')
          artProblems.set(name, {
            kind: 'art_pending',
            message: `"${name}" is still being drawn; a placeholder of its shape shows until it is ready (nothing to fix).`,
          })
        else if (ref.status === 'failed')
          artProblems.set(name, {
            kind: 'art_failed',
            message: `Drawing "${name}" failed; draw it again once with design_draw (same name).`,
          })
      }
      const icon = attr(node, 'data-icon')
      if (icon !== null && tag !== 'svg') {
        const svg = iconSvg(icon, node.attrs)
        const replacement = parseFragment(
          svg ??
            `<span data-icon-missing="${icon.replace(/"/g, '')}" class="${(attr(node, 'class') ?? '').replace(/"/g, '')}" style="display:inline-block;width:24px;height:24px;border:1.5px dashed #e5484d;border-radius:4px;box-sizing:border-box"></span>`,
        ).childNodes[0] as Element
        if (!svg) missingIcons.add(icon)
        replacement.parentNode = parent
        children[i] = replacement
        for (const name of (attr(replacement, 'class') ?? '').split(/\s+/)) if (name) candidates.add(name)
        continue
      }
      for (const name of (attr(node, 'class') ?? '').split(/\s+/)) if (name) candidates.add(name)
      visit(node)
      const content = (node as DefaultTreeAdapterTypes.Template).content
      if (tag === 'template' && content) visit(content)
    }
  }
  visit(fragment)
  problems.push(...artProblems.values())
  for (const icon of missingIcons)
    problems.push({
      kind: 'unknown_icon',
      message: `Unknown icon "${icon}" (Lucide names, e.g. lucide:arrow-right); a dashed box stands in for it.`,
    })
  return { html: serialize(fragment), candidates: [...candidates], text: text.join(' '), problems }
}

function placeArt(node: Element, ref: ArtRef | null): void {
  node.tagName = 'img'
  node.nodeName = 'img'
  node.childNodes = []
  // Unknown until its design_draw runs (a draft may name it first): a neutral block, never a broken image.
  const src =
    ref?.status === 'ready' ? `asset:${ref.sha}` : artPlaceholder(ref?.width ?? 100, ref?.height ?? 100)
  node.attrs = [...node.attrs.filter((a) => a.name !== 'src'), { name: 'src', value: src }]
  if (ref && !node.attrs.some((a) => a.name === 'width' || a.name === 'height'))
    node.attrs.push(
      { name: 'width', value: String(ref.width) },
      { name: 'height', value: String(ref.height) },
    )
}

/** A bot's CSS without `@import` rules (nothing is loaded from outside the frame). */
export function stripImports(css: string): string {
  return css.replace(/@import\s+[^;]+;?/gi, '')
}

/**
 * Image sources to bring into the design when a frame is saved: files in /workspace, http(s) URLs and
 * data: URIs (they become `asset:<sha>`).
 */
export function externalImageSources(html: string, css: string): string[] {
  const found = new Set<string>()
  const fragment = parseFragment(html)
  const visit = (parent: ParentNode) => {
    for (const node of childrenOf(parent)) {
      if (!isElement(node)) continue
      for (const a of node.attrs) {
        if (a.name === 'src' || a.name === 'poster' || (a.name === 'href' && node.tagName === 'image'))
          if (isImportable(a.value)) found.add(a.value.trim())
        if (a.name === 'style') for (const url of cssUrls(a.value)) found.add(url)
      }
      visit(node)
    }
  }
  visit(fragment)
  for (const url of cssUrls(css)) found.add(url)
  return [...found]
}

function isImportable(value: string): boolean {
  const v = value.trim()
  return v.startsWith('/workspace/') || /^https?:\/\//i.test(v) || /^data:image\//i.test(v)
}

function cssUrls(css: string): string[] {
  const out: string[] = []
  for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
    const value = (m[2] as string).trim()
    if (isImportable(value)) out.push(value)
  }
  return out
}

/** Replaces each imported source (as written, quoted or in `url()`) with its `asset:<sha>`. */
export function replaceSources(source: string, replacements: ReadonlyMap<string, string>): string {
  let out = source
  for (const [from, to] of replacements) {
    out = out
      .split(`"${from}"`)
      .join(`"${to}"`)
      .split(`'${from}'`)
      .join(`'${to}'`)
      .split(`(${from})`)
      .join(`(${to})`)
  }
  return out
}

/** A frame as written, for coding bots: its HTML with Tailwind classes, its CSS and the tokens file. */
export function sourceDocument(design: DesignRow, frame: FrameRow, theme: string): string {
  const escape = (value: string) => value.replace(/--/g, '- -')
  return [
    `<!-- Frame "${escape(frame.name)}" of the design "${escape(design.name)}": ${frame.width}×${frame.height ?? 'auto'}, theme "${escape(theme)}".`,
    '     Tailwind v4 classes; the tokens are CSS variables in tokens.css (also a Tailwind @theme block);',
    '     <i data-icon="lucide:name"> are Lucide icons; asset:<sha> images are embedded in the standalone .html. -->',
    '<link rel="stylesheet" href="tokens.css">',
    ...(frame.css.trim() ? ['<style>', frame.css.trim(), '</style>'] : []),
    `<div data-theme="${theme.replace(/"/g, '')}">`,
    frame.html.trim(),
    '</div>',
    '',
  ].join('\n')
}
