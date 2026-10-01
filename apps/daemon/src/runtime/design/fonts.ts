import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { DesignProblem, LogFn } from '@milibot/shared'

import { errorMessage } from '../../errors'
import type { DesignAssets } from './assets'

export type FontFetch = (url: string, init?: RequestInit) => Promise<Response>

interface StoredFace {
  subset: string
  file: string
  weight: string
  style: string
  unicodeRange: string | null
}

const SUBSETS = ['latin', 'latin-ext'] as const
const LATIN_RANGE =
  'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD'
const LATIN_EXT_RANGE =
  'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF'
const MAX_FONT_BYTES = 3 * 1024 * 1024
const RETRY_FAILED_MS = 10 * 60_000
/** Google serves woff2 to browsers it recognizes. */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

export const FONT_FAMILY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ]{0,59}$/

/** Text with characters only the latin-ext subsets draw (Polish, Czech, Vietnamese…). */
export function needsLatinExt(text: string): boolean {
  return /[Ā-İĲ-őŔ-ɏḀ-ỿ]/.test(text)
}

function slug(family: string): string {
  return family.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

/** `@font-face` blocks of a Google Fonts css2 response, only the latin subsets. */
export function parseGoogleCss(css: string): Array<Omit<StoredFace, 'file'> & { url: string }> {
  const faces: Array<Omit<StoredFace, 'file'> & { url: string }> = []
  for (const m of css.matchAll(/\/\*\s*([a-z0-9-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g)) {
    const subset = m[1] as string
    if (!(SUBSETS as readonly string[]).includes(subset)) continue
    const body = m[2] as string
    const url = /src:\s*url\(([^)]+)\)/.exec(body)?.[1]?.replace(/['"]/g, '')
    if (!url) continue
    faces.push({
      subset,
      url,
      weight: /font-weight:\s*([^;]+);/.exec(body)?.[1]?.trim() ?? '400',
      style: /font-style:\s*([^;]+);/.exec(body)?.[1]?.trim() ?? 'normal',
      unicodeRange: /unicode-range:\s*([^;]+);/.exec(body)?.[1]?.trim() ?? null,
    })
  }
  return faces
}

function fontFace(family: string, data: Buffer, weight: string, style: string, range: string | null): string {
  return [
    '@font-face {',
    `  font-family: "${family}";`,
    `  src: url(data:font/woff2;base64,${data.toString('base64')}) format("woff2");`,
    `  font-weight: ${weight};`,
    `  font-style: ${style};`,
    '  font-display: block;',
    ...(range ? [`  unicode-range: ${range};`] : []),
    '}',
  ].join('\n')
}

/**
 * Fonts embedded in compiled frames: Inter (bundled) and Google Fonts families, downloaded once into
 * `<dataRoot>/fonts/<family>/` (latin and latin-ext subsets, variable weights when the family has them).
 */
export class FontLibrary {
  private readonly files = new Map<string, Buffer>()
  private readonly failed = new Map<string, number>()
  private readonly downloads = new Map<string, Promise<StoredFace[] | null>>()

  constructor(
    private readonly options: {
      dir: string | null
      assets: DesignAssets | null
      fetch?: FontFetch
      now?: () => number
      log?: LogFn
    },
  ) {}

  private read(path: string): Buffer | null {
    const cached = this.files.get(path)
    if (cached) return cached
    try {
      const data = readFileSync(path)
      this.files.set(path, data)
      return data
    } catch {
      return null
    }
  }

  /** `@font-face` rules for Inter and the given families, with the subsets the text needs. */
  async css(families: readonly string[], text: string): Promise<{ css: string; problems: DesignProblem[] }> {
    const ext = needsLatinExt(text)
    const rules: string[] = []
    const problems: DesignProblem[] = []
    const assets = this.options.assets
    const inter = assets ? this.read(assets.interLatin) : null
    if (inter) rules.push(fontFace('Inter', inter, '100 900', 'normal', LATIN_RANGE))
    const interExt = ext && assets ? this.read(assets.interLatinExt) : null
    if (interExt) rules.push(fontFace('Inter', interExt, '100 900', 'normal', LATIN_EXT_RANGE))
    for (const family of families) {
      if (/^inter$/i.test(family)) continue
      const faces = await this.ensure(family)
      if (!faces) {
        problems.push({
          kind: 'font_unavailable',
          message: `The font "${family}" could not be loaded from Google Fonts; a fallback font is shown.`,
        })
        continue
      }
      for (const face of faces) {
        if (face.subset === 'latin-ext' && !ext) continue
        const data = this.read(join(this.familyDir(family), face.file))
        if (data) rules.push(fontFace(family, data, face.weight, face.style, face.unicodeRange))
      }
    }
    return { css: rules.join('\n'), problems }
  }

  private familyDir(family: string): string {
    return join(this.options.dir as string, slug(family))
  }

  private ensure(family: string): Promise<StoredFace[] | null> {
    if (!this.options.dir || !FONT_FAMILY_PATTERN.test(family)) return Promise.resolve(null)
    const index = join(this.familyDir(family), 'faces.json')
    if (existsSync(index)) {
      try {
        return Promise.resolve(JSON.parse(readFileSync(index, 'utf8')) as StoredFace[])
      } catch {
        // Rewritten below.
      }
    }
    const now = this.options.now?.() ?? Date.now()
    const failedAt = this.failed.get(family)
    if (failedAt !== undefined && now - failedAt < RETRY_FAILED_MS) return Promise.resolve(null)
    const pending = this.downloads.get(family)
    if (pending) return pending
    const download = this.download(family)
      .catch((err: unknown) => {
        this.options.log?.('warn', 'font download failed', { family, err: errorMessage(err) })
        this.failed.set(family, this.options.now?.() ?? Date.now())
        return null
      })
      .finally(() => this.downloads.delete(family))
    this.downloads.set(family, download)
    return download
  }

  private async download(family: string): Promise<StoredFace[]> {
    const doFetch = this.options.fetch ?? fetch
    const name = encodeURIComponent(family).replace(/%20/g, '+')
    let css: string | null = null
    for (const axis of [':wght@100..900', ':wght@400;500;600;700', '']) {
      const res = await doFetch(`https://fonts.googleapis.com/css2?family=${name}${axis}&display=swap`, {
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(20_000),
      })
      if (res.ok) {
        css = await res.text()
        break
      }
      if (res.status !== 400) throw new Error(`Google Fonts answered ${res.status}`)
    }
    if (!css) throw new Error('unknown family')
    const faces = parseGoogleCss(css)
    if (faces.length === 0) throw new Error('no latin faces')
    const dir = this.familyDir(family)
    mkdirSync(dir, { recursive: true })
    const stored: StoredFace[] = []
    for (const [i, face] of faces.entries()) {
      const res = await doFetch(face.url, { signal: AbortSignal.timeout(30_000) })
      if (!res.ok) throw new Error(`font file answered ${res.status}`)
      const data = Buffer.from(await res.arrayBuffer())
      if (data.length > MAX_FONT_BYTES) throw new Error('font file too large')
      const file = `${face.subset}-${i}.woff2`
      writeFileSync(join(dir, file), data)
      stored.push({
        subset: face.subset,
        file,
        weight: face.weight,
        style: face.style,
        unicodeRange: face.unicodeRange,
      })
    }
    const index = join(dir, 'faces.json')
    writeFileSync(`${index}.tmp`, JSON.stringify(stored))
    renameSync(`${index}.tmp`, index)
    this.options.log?.('info', 'font downloaded', { family, faces: stored.length })
    return stored
  }
}
