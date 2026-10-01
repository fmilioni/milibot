import { optionalIntLike, type ToolArgs, trimmedString } from '@milibot/agent/tools'
import { DESIGN_LIMITS } from '@milibot/shared'

import { FONT_FAMILY_PATTERN } from '../fonts'
import type { FrameSize } from '../frames'
import { DesignInputError } from '../tokens'

export function fontList(raw: unknown): string[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new DesignInputError('"fonts" must be a list of Google Fonts family names')
  const fonts = [...new Set(raw.map((f) => trimmedString(f)).filter(Boolean))]
  for (const family of fonts)
    if (!FONT_FAMILY_PATTERN.test(family)) throw new DesignInputError(`"${family}" is not a font family name`)
  if (fonts.length > DESIGN_LIMITS.fonts) throw new DesignInputError(`at most ${DESIGN_LIMITS.fonts} fonts`)
  return fonts
}

/** `width` and `height` of a frame; a height left out, 0 or "auto" grows with the content. */
export function frameSizeArgs(a: ToolArgs): FrameSize {
  const width = optionalIntLike(a, 'width')
  if (width === null || width < 16 || width > DESIGN_LIMITS.frameSide)
    throw new DesignInputError(`"width" must be 16 to ${DESIGN_LIMITS.frameSide} pixels`)
  const raw = a.height
  const height = raw === 'auto' || raw === 0 || raw === '0' ? null : optionalIntLike(a, 'height')
  if (height !== null && (height < 16 || height > DESIGN_LIMITS.frameSide))
    throw new DesignInputError(
      `"height" must be 16 to ${DESIGN_LIMITS.frameSide} pixels, or omitted to grow with the content`,
    )
  return { width, height }
}

export function checkSource(html: string, css: string): void {
  if (Buffer.byteLength(html) > DESIGN_LIMITS.frameHtmlBytes)
    throw new DesignInputError(
      `the HTML is larger than ${DESIGN_LIMITS.frameHtmlBytes / 1024} KB; split it into frames`,
    )
  if (Buffer.byteLength(css) > DESIGN_LIMITS.frameCssBytes)
    throw new DesignInputError(`the CSS is larger than ${DESIGN_LIMITS.frameCssBytes / 1024} KB`)
}
