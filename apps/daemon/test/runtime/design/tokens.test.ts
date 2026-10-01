import type { DesignToken } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import {
  applyTokenChanges,
  checkThemes,
  parseTokenChanges,
  retheme,
  themeBlock,
  tokensCss,
  tokenValue,
} from '../../../src/runtime/design/tokens'

const THEMES = ['Light', 'Night']

describe('design tokens', () => {
  it('names colors and fonts in their Tailwind namespaces and infers types', () => {
    const { tokens, changed } = applyTokenChanges(
      [],
      parseTokenChanges([
        { name: 'primary', values: { light: '#0a7', NIGHT: 'oklch(70% 0.1 150)' } },
        { name: 'display', type: 'font', value: 'Fraunces' },
        { name: 'radius-card', value: 14 },
        { name: '--Shadow Card', value: '0 1px 2px rgb(0 0 0 / 0.1)' },
      ]),
      THEMES,
    )
    expect(changed).toEqual(['color-primary', 'font-display', 'radius-card', 'shadow-card'])
    expect(tokens).toEqual([
      {
        name: 'color-primary',
        type: 'color',
        value: null,
        values: { Light: '#0a7', Night: 'oklch(70% 0.1 150)' },
      },
      { name: 'font-display', type: 'font', value: 'Fraunces', values: {} },
      { name: 'radius-card', type: 'number', value: 14, values: {} },
      { name: 'shadow-card', type: 'string', value: '0 1px 2px rgb(0 0 0 / 0.1)', values: {} },
    ])
  })

  it('merges by name: one value for all themes, or only the themes given', () => {
    const base = applyTokenChanges(
      [],
      [
        { name: 'color-bg', values: { Light: '#fff', Night: '#000' } },
        { name: 'radius-card', value: 8 },
      ],
      THEMES,
    ).tokens
    const perTheme = applyTokenChanges(base, [{ name: 'bg', values: { Night: '#111' } }], THEMES).tokens
    expect(perTheme[0]).toMatchObject({ name: 'color-bg', values: { Light: '#fff', Night: '#111' } })
    const single = applyTokenChanges(perTheme, [{ name: 'color-bg', value: '#eee' }], THEMES).tokens
    expect(single[0]).toMatchObject({ value: '#eee', values: {} })
    const removed = applyTokenChanges(single, [{ name: 'radius-card', delete: true }], THEMES)
    expect(removed.tokens.map((t) => t.name)).toEqual(['color-bg'])
    expect(tokenValue(perTheme[0] as DesignToken, 'Night', THEMES)).toBe('#111')
  })

  it('refuses what would break the CSS or name no theme', () => {
    expect(() => applyTokenChanges([], [{ name: 'x', value: 'red; } body { display:none' }], THEMES)).toThrow(
      /single CSS value/,
    )
    expect(() => applyTokenChanges([], [{ name: 'color-x', values: { Blue: '#00f' } }], THEMES)).toThrow(
      /no theme "Blue"/,
    )
    expect(() => applyTokenChanges([], [{ name: 'Bad Name!', value: 1 }], THEMES)).toThrow(/lowercase/)
    expect(() => applyTokenChanges([], [{ name: 'color-x' }], THEMES)).toThrow(/needs a value/)
    expect(() => parseTokenChanges([{ name: 'x', type: 'weird' }])).toThrow(/type/)
    expect(() => checkThemes(['A', 'a'])).toThrow(/repeated/)
    expect(() => checkThemes([])).toThrow(/at least one/)
  })

  it('builds the @theme block of a theme and the tokens.css of an export', () => {
    const { tokens } = applyTokenChanges(
      [],
      [
        { name: 'primary', values: { Light: '#0a7', Night: '#3c9' } },
        { name: 'font-weight-bold', value: 650 },
        { name: 'spacing-gutter', value: 24 },
        { name: 'display', type: 'font', value: 'Space Grotesk' },
      ],
      THEMES,
    )
    expect(themeBlock(tokens, 'Night', THEMES)).toBe(
      '@theme static {\n  --color-primary: #3c9;\n  --font-weight-bold: 650;\n  --spacing-gutter: 24px;\n' +
        '  --font-display: "Space Grotesk", ui-sans-serif, system-ui, sans-serif;\n}',
    )
    const css = tokensCss('Store', tokens, THEMES)
    expect(css).toContain(':root,\n[data-theme="Light"] {\n  --color-primary: #0a7;')
    expect(css).toContain('[data-theme="Night"] {\n  --color-primary: #3c9;\n}')
    expect(css).toMatch(/@theme \{\n {2}--color-primary: #0a7;/)
  })

  it('follows renamed and removed themes', () => {
    const tokens = applyTokenChanges(
      [],
      [{ name: 'color-bg', values: { Light: '#fff', Night: '#000' } }],
      THEMES,
    ).tokens
    expect(retheme(tokens, ['Day'], new Map([['Light', 'Day']]))[0]?.values).toEqual({ Day: '#fff' })
  })
})
