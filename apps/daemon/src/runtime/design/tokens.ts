import { ToolInputError } from '@milibot/agent/tools'
import {
  DESIGN_LIMITS,
  type DesignToken,
  type DesignTokenType,
  type DesignTokenValue,
  foldText,
} from '@milibot/shared'

export class DesignInputError extends ToolInputError {}

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/
const THEME_MAX_LENGTH = 40
const TYPES: readonly DesignTokenType[] = ['color', 'number', 'string', 'font']
const COLOR_VALUE = /^(#[0-9a-f]{3,8}|(rgba?|hsla?|oklch|oklab|lab|lch|color|color-mix)\(.*\)|transparent)$/i
/** Namespaces whose bare numbers have no unit. */
const UNITLESS = /^(font-weight|leading|line-height|opacity|z|scale|order|aspect|flex|columns)(-|$)/

/** What a bot sends for one token (`design_create`, `design_set_tokens`). */
export interface TokenChange {
  name: string
  type?: DesignTokenType
  value?: DesignTokenValue
  values?: Record<string, DesignTokenValue>
  delete?: boolean
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Folds for comparing theme and token names a bot typed. */
export function foldName(value: string): string {
  return foldText(value, { trim: true })
}

/** `primary` as a color → `color-primary`; `--Radius Card` → `radius-card`. */
function normalizeTokenName(raw: string, type: DesignTokenType | null): string {
  let name = raw
    .trim()
    .replace(/^--/, '')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
  if (type === 'color' && !name.startsWith('color-')) name = `color-${name}`
  if (type === 'font' && !name.startsWith('font-')) name = `font-${name}`
  if (!NAME_PATTERN.test(name) || name.length > 64)
    throw new DesignInputError(
      `token name "${raw}" must be lowercase letters, digits and hyphens (a CSS variable name without --)`,
    )
  return name
}

function inferType(name: string, value: unknown): DesignTokenType {
  if (name.startsWith('color-')) return 'color'
  if (name.startsWith('font-') && !name.startsWith('font-weight')) return 'font'
  if (typeof value === 'string' && COLOR_VALUE.test(value.trim())) return 'color'
  if (typeof value === 'number' || (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())))
    return 'number'
  return 'string'
}

function checkValue(name: string, type: DesignTokenType, raw: unknown): DesignTokenValue {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw new DesignInputError(`${name}: not a finite number`)
    return raw
  }
  if (typeof raw !== 'string' || !raw.trim())
    throw new DesignInputError(`${name}: the value must be a string or a number`)
  const value = raw.trim()
  if (/[;{}<>]/.test(value) || /\/\*/.test(value))
    throw new DesignInputError(`${name}: "${value}" is not a single CSS value`)
  if (type === 'number' && /^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  return value
}

/** Validates the theme list (non-empty, unique names, short). */
export function checkThemes(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new DesignInputError('"themes" must be a list of names')
  const themes: string[] = []
  for (const item of raw) {
    const name = typeof item === 'string' ? item.trim() : ''
    if (!name || name.length > THEME_MAX_LENGTH)
      throw new DesignInputError(`theme names must have 1 to ${THEME_MAX_LENGTH} characters`)
    if (themes.some((t) => foldName(t) === foldName(name)))
      throw new DesignInputError(`theme "${name}" is repeated`)
    themes.push(name)
  }
  if (themes.length === 0) throw new DesignInputError('a design needs at least one theme')
  if (themes.length > DESIGN_LIMITS.themes)
    throw new DesignInputError(`at most ${DESIGN_LIMITS.themes} themes`)
  return themes
}

/** The theme a name refers to (case and accents ignored), or null. */
export function findTheme(themes: readonly string[], name: string): string | null {
  const key = foldName(name)
  return themes.find((t) => foldName(t) === key) ?? null
}

/** Parses the `tokens` argument of a tool. */
export function parseTokenChanges(raw: unknown): TokenChange[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new DesignInputError('"tokens" must be a list')
  return raw.map((item, i) => {
    const t = asRecord(item)
    if (!t || typeof t.name !== 'string') throw new DesignInputError(`tokens[${i}] needs a name`)
    if (t.type !== undefined && !TYPES.includes(t.type as DesignTokenType))
      throw new DesignInputError(`tokens[${i}].type must be one of ${TYPES.join(', ')}`)
    const values = t.values === undefined || t.values === null ? undefined : asRecord(t.values)
    if (t.values !== undefined && t.values !== null && !values)
      throw new DesignInputError(`tokens[${i}].values must be an object {theme: value}`)
    return {
      name: t.name,
      ...(t.type !== undefined ? { type: t.type as DesignTokenType } : {}),
      ...(t.value !== undefined && t.value !== null ? { value: t.value as DesignTokenValue } : {}),
      ...(values ? { values: values as Record<string, DesignTokenValue> } : {}),
      ...(t.delete === true ? { delete: true } : {}),
    }
  })
}

/**
 * Merges token changes into a design's tokens (by name). `value` sets one value for every theme (dropping
 * per-theme values); `values` sets the listed themes and keeps the others.
 */
export function applyTokenChanges(
  tokens: readonly DesignToken[],
  changes: readonly TokenChange[],
  themes: readonly string[],
): { tokens: DesignToken[]; changed: string[] } {
  const next = tokens.map((t) => ({ ...t, values: { ...t.values } }))
  const changed: string[] = []
  for (const change of changes) {
    const guess = change.type ?? null
    let name = normalizeTokenName(change.name, guess)
    let index = next.findIndex((t) => t.name === name)
    if (index < 0 && !guess) {
      // "primary" names the existing color-primary / font-primary.
      const prefixed = next.findIndex((t) => t.name === `color-${name}` || t.name === `font-${name}`)
      if (prefixed >= 0) {
        index = prefixed
        name = (next[prefixed] as DesignToken).name
      }
    }
    if (change.delete) {
      if (index >= 0) {
        next.splice(index, 1)
        changed.push(name)
      }
      continue
    }
    const existing = index >= 0 ? (next[index] as DesignToken) : null
    const firstValue = change.value ?? Object.values(change.values ?? {})[0]
    const type = change.type ?? existing?.type ?? inferType(name, firstValue)
    if (!existing && guess === null && (type === 'color' || type === 'font'))
      name = normalizeTokenName(name, type)
    if (!existing && change.value === undefined && !Object.keys(change.values ?? {}).length)
      throw new DesignInputError(`${name}: a new token needs a value or values`)
    const token: DesignToken = existing ? { ...existing, type } : { name, type, value: null, values: {} }
    if (change.value !== undefined) {
      token.value = checkValue(name, type, change.value)
      if (!change.values) token.values = {}
    }
    for (const [themeName, raw] of Object.entries(change.values ?? {})) {
      const theme = findTheme(themes, themeName)
      if (!theme)
        throw new DesignInputError(`${name}: there is no theme "${themeName}" (themes: ${themes.join(', ')})`)
      token.values[theme] = checkValue(name, type, raw)
    }
    if (existing) next[index] = token
    else next.push(token)
    changed.push(name)
  }
  if (next.length > DESIGN_LIMITS.tokens) throw new DesignInputError(`at most ${DESIGN_LIMITS.tokens} tokens`)
  return { tokens: next, changed }
}

/** Keeps token values in step with a new theme list (renamed themes carried over, removed ones dropped). */
export function retheme(
  tokens: readonly DesignToken[],
  themes: readonly string[],
  renamed: ReadonlyMap<string, string> = new Map(),
): DesignToken[] {
  return tokens.map((t) => {
    const values: Record<string, DesignTokenValue> = {}
    for (const [theme, value] of Object.entries(t.values)) {
      const target = renamed.get(theme) ?? theme
      if (themes.includes(target)) values[target] = value
    }
    return { ...t, values }
  })
}

/** The token's value in a theme (its own, else the one for all, else the first theme's). */
export function tokenValue(
  token: DesignToken,
  theme: string,
  themes: readonly string[],
): DesignTokenValue | null {
  if (theme in token.values) return token.values[theme] as DesignTokenValue
  if (token.value !== null) return token.value
  const first = themes[0]
  if (first && first in token.values) return token.values[first] as DesignTokenValue
  return Object.values(token.values)[0] ?? null
}

/** The value as CSS: bare numbers are px except for unitless namespaces; a lone font family gets fallbacks. */
function cssValue(token: DesignToken, value: DesignTokenValue): string {
  if (typeof value === 'number') return UNITLESS.test(token.name) ? String(value) : `${value}px`
  if (
    token.type === 'font' &&
    !/[,"']/.test(value) &&
    !/^(ui-|system-ui|serif|sans-serif|monospace)/.test(value)
  )
    return `"${value}", ui-sans-serif, system-ui, sans-serif`
  return value
}

function declarations(tokens: readonly DesignToken[], theme: string, themes: readonly string[]): string[] {
  return tokens.flatMap((t) => {
    const value = tokenValue(t, theme, themes)
    return value === null ? [] : [`  --${t.name}: ${cssValue(t, value)};`]
  })
}

/** `@theme static` block of a frame's theme: CSS variables that are also Tailwind utilities. */
export function themeBlock(tokens: readonly DesignToken[], theme: string, themes: readonly string[]): string {
  const lines = declarations(tokens, theme, themes)
  return lines.length ? `@theme static {\n${lines.join('\n')}\n}` : ''
}

/** Families named by font tokens in a theme (quoted or bare first family). */
export function fontFamilies(
  tokens: readonly DesignToken[],
  theme: string,
  themes: readonly string[],
): string[] {
  const families: string[] = []
  for (const t of tokens) {
    if (t.type !== 'font') continue
    const value = tokenValue(t, theme, themes)
    if (typeof value !== 'string') continue
    for (const part of value.split(',')) {
      const family = part.trim().replace(/^["']|["']$/g, '')
      if (family && !/^(ui-|system-ui|serif|sans-serif|monospace|cursive|fantasy)/.test(family))
        families.push(family)
    }
  }
  return families
}

function themeSelector(theme: string): string {
  return `[data-theme="${theme.replace(/["\\]/g, '')}"]`
}

/**
 * `tokens.css` of an export: the default theme on `:root`, the others under `[data-theme="<name>"]`, and the
 * same variables as a Tailwind v4 `@theme` block (plain CSS ignores it).
 */
export function tokensCss(
  designName: string,
  tokens: readonly DesignToken[],
  themes: readonly string[],
): string {
  const [first = 'default', ...others] = themes
  const out = [
    `/* Design tokens of "${designName.replace(/\*\//g, '')}". Themes: ${themes.join(', ')} (${first} is the default). */`,
    `:root,\n${themeSelector(first)} {\n${declarations(tokens, first, themes).join('\n')}\n}`,
  ]
  for (const theme of others) {
    const own = tokens.filter((t) => theme in t.values)
    if (own.length) out.push(`${themeSelector(theme)} {\n${declarations(own, theme, themes).join('\n')}\n}`)
  }
  out.push(
    '/* Tailwind v4: import this file after tailwindcss to get utilities such as bg-primary or rounded-card. */',
    `@theme {\n${declarations(tokens, first, themes).join('\n')}\n}`,
  )
  return `${out.join('\n\n')}\n`
}

/** Tokens as a table for the bot: one column per theme, or "(all themes)" for single values. */
export function tokensTable(tokens: readonly DesignToken[], themes: readonly string[]): string {
  if (tokens.length === 0) return 'Tokens: none yet.'
  const lines = [`Tokens (name | type | ${themes.join(' | ')}):`]
  for (const t of tokens) {
    const perTheme = Object.keys(t.values).length > 0
    const cells = perTheme
      ? themes.map((theme) => String(tokenValue(t, theme, themes) ?? '—'))
      : [`${String(t.value)} (all themes)`]
    lines.push(`${t.name} | ${t.type} | ${cells.join(' | ')}`)
  }
  return lines.join('\n')
}
