import type { DesignToken, DesignTokenType } from '@milibot/shared'

export type TokenGroup = 'colors' | 'numbers' | 'fonts' | 'texts'

const GROUP_OF: Record<DesignTokenType, TokenGroup> = {
  color: 'colors',
  number: 'numbers',
  font: 'fonts',
  string: 'texts',
}
const GROUP_ORDER: TokenGroup[] = ['colors', 'numbers', 'fonts', 'texts']

/** Tokens by kind, in the variables panel's order (colors, numbers, fonts, texts), keeping their order. */
export function groupTokens(
  tokens: readonly DesignToken[],
): Array<{ group: TokenGroup; tokens: DesignToken[] }> {
  return GROUP_ORDER.map((group) => ({
    group,
    tokens: tokens.filter((t) => GROUP_OF[t.type] === group),
  })).filter((g) => g.tokens.length > 0)
}

/** `color-primary` shows as `primary` (the column says it is a color); other names stay whole. */
export function tokenLabel(token: DesignToken): string {
  return token.type === 'color' ? token.name.replace(/^color-/, '') : token.name
}

const COLOR = /^(#[0-9a-f]{3,8}|(rgba?|hsla?|oklch|oklab|lab|lch|color|color-mix)\(.*\)|transparent)$/i
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const NUMBER = /^-?\d+(\.\d+)?$/
const LENGTH = /^-?\d*\.?\d+(px|rem|em|%|vw|vh|ch|pt)$/i

export type TokenInputResult =
  { ok: true; value: string | number } | { ok: false; reason: 'empty' | 'invalid' }

/** Checks what the user typed for a token (the daemon checks again). Bare numbers become numbers. */
export function parseTokenInput(type: DesignTokenType, raw: string): TokenInputResult {
  const value = raw.trim()
  if (!value) return { ok: false, reason: 'empty' }
  if (/[;{}<>]/.test(value) || value.includes('/*')) return { ok: false, reason: 'invalid' }
  if (type === 'color') {
    if (/^[0-9a-f]{6}$/i.test(value)) return { ok: true, value: `#${value.toUpperCase()}` }
    return COLOR.test(value) ? { ok: true, value } : { ok: false, reason: 'invalid' }
  }
  if (type === 'number') {
    if (NUMBER.test(value)) return { ok: true, value: Number(value) }
    return LENGTH.test(value) ? { ok: true, value } : { ok: false, reason: 'invalid' }
  }
  return { ok: true, value }
}

/** `#abc` → `#aabbcc` for the native color picker (which only takes 6-digit hex); null for others. */
export function pickerHex(value: string): string | null {
  const v = value.trim()
  if (!HEX.test(v)) return null
  const hex = v.slice(1)
  if (hex.length === 3 || hex.length === 4)
    return `#${[...hex.slice(0, 3)].map((c) => c + c).join('')}`.toLowerCase()
  return `#${hex.slice(0, 6)}`.toLowerCase()
}

/**
 * The patch of a user edit (`PATCH …/tokens`): one theme's value, or `*` for a token that has one value
 * for every theme.
 */
export function tokenEdit(
  token: DesignToken,
  theme: string,
  value: string | number,
): Record<string, Record<string, string | number>> {
  return { [token.name]: { [token.value !== null ? '*' : theme]: value } }
}

/** The token with the edit applied (optimistic update). */
export function applyTokenEdit(token: DesignToken, theme: string, value: string | number): DesignToken {
  if (token.value !== null) return { ...token, value }
  return { ...token, values: { ...token.values, [theme]: value } }
}
