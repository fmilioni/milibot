import { describe, expect, it } from 'vitest'

import en from '@/i18n/locales/en'
import ptBR from '@/i18n/locales/pt-BR'

import { localeFor } from './platform-texts'

function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k))
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] ?? '').sort()
}

describe('locales', () => {
  it('pt-BR and en define the same keys', () => {
    expect(keys(en).sort()).toEqual(keys(ptBR).sort())
  })

  it('use the same interpolation variables', () => {
    const get = (obj: unknown, path: string) =>
      path.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown>)[k], obj)
    for (const key of keys(ptBR)) {
      expect(placeholders(String(get(en, key))), key).toEqual(placeholders(String(get(ptBR, key))))
    }
  })
})

describe('platform texts', () => {
  it('platformPc only overrides existing keys', () => {
    const all = new Set(keys(ptBR).filter((k) => !k.startsWith('platformPc.')))
    for (const key of keys(ptBR.platformPc)) expect(all.has(key), key).toBe(true)
  })

  it('no macOS wording is shown on Linux or Windows', () => {
    for (const locale of [ptBR, en]) {
      const shown = localeFor(locale, 'linux') as unknown
      const get = (path: string) =>
        path.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown>)[k], shown)
      const offenders = keys(shown)
        .filter((key) => !key.startsWith('platformPc.'))
        .filter((key) => /\b(mac|macos|finder|keychain)\b|[⌘⌥]/i.test(String(get(key))))
      expect(offenders).toEqual([])
    }
  })

  it('macOS keeps its own texts', () => {
    expect(localeFor(ptBR, 'mac').settings.general.reveal).toBe('Mostrar no Finder')
    expect(localeFor(ptBR, 'linux').settings.general.reveal).toBe('Mostrar na pasta')
  })
})
