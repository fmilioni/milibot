import type { DesignToken } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import {
  applyTokenEdit,
  groupTokens,
  parseTokenInput,
  pickerHex,
  tokenEdit,
  tokenLabel,
} from './design-tokens'

const token = (
  name: string,
  type: DesignToken['type'],
  value: string | number | null,
  values = {},
): DesignToken => ({
  name,
  type,
  value,
  values,
})

describe('variables panel', () => {
  it('groups tokens by kind and drops the color prefix', () => {
    const tokens = [
      token('radius-card', 'number', 12),
      token('color-primary', 'color', null, { Green: '#0a7' }),
      token('font-body', 'font', 'Inter'),
    ]
    expect(groupTokens(tokens).map((g) => [g.group, g.tokens.map(tokenLabel)])).toEqual([
      ['colors', ['primary']],
      ['numbers', ['radius-card']],
      ['fonts', ['font-body']],
    ])
  })

  it('validates what the user typed', () => {
    expect(parseTokenInput('color', '#0B8A5F')).toEqual({ ok: true, value: '#0B8A5F' })
    expect(parseTokenInput('color', '0b8a5f')).toEqual({ ok: true, value: '#0B8A5F' })
    expect(parseTokenInput('color', 'oklch(0.7 0.1 150)')).toMatchObject({ ok: true })
    expect(parseTokenInput('color', 'green')).toEqual({ ok: false, reason: 'invalid' })
    expect(parseTokenInput('color', ' ')).toEqual({ ok: false, reason: 'empty' })
    expect(parseTokenInput('number', '12')).toEqual({ ok: true, value: 12 })
    expect(parseTokenInput('number', '1.5rem')).toEqual({ ok: true, value: '1.5rem' })
    expect(parseTokenInput('number', 'twelve')).toEqual({ ok: false, reason: 'invalid' })
    expect(parseTokenInput('font', '"Fraunces", serif')).toMatchObject({ ok: true })
    expect(parseTokenInput('string', 'a; b')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('feeds the native color picker 6-digit hex only', () => {
    expect(pickerHex('#ABC')).toBe('#aabbcc')
    expect(pickerHex('#0B8A5F80')).toBe('#0b8a5f')
    expect(pickerHex('rgb(1 2 3)')).toBeNull()
  })

  it('edits one theme, or every theme of a single-value token', () => {
    const perTheme = token('color-primary', 'color', null, { Green: '#0a7', Night: '#123' })
    const shared = token('radius-card', 'number', 12)
    expect(tokenEdit(perTheme, 'Night', '#456')).toEqual({ 'color-primary': { Night: '#456' } })
    expect(tokenEdit(shared, 'Green', 16)).toEqual({ 'radius-card': { '*': 16 } })
    expect(applyTokenEdit(perTheme, 'Night', '#456').values).toEqual({ Green: '#0a7', Night: '#456' })
    expect(applyTokenEdit(shared, 'Night', 16).value).toBe(16)
  })
})
