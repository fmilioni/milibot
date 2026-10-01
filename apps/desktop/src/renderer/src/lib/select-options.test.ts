import i18next, { type TFunction } from 'i18next'
import { beforeAll, describe, expect, it } from 'vitest'

import en from '@/i18n/locales/en'

import { botNames, botOptions, GENERAL_PROJECT, projectOptions } from './select-options'

describe('select options', () => {
  let t: TFunction
  beforeAll(async () => {
    const instance = i18next.createInstance()
    await instance.init({ lng: 'en', resources: { en: { translation: en } } })
    t = instance.getFixedT('en')
  })

  const bots = {
    b2: { id: 'b2', name: 'Zed' },
    b1: { id: 'b1', name: 'Ana' },
  }

  it('lists bots by name', () => {
    expect(botOptions(bots)).toEqual([
      { value: 'b1', label: 'Ana' },
      { value: 'b2', label: 'Zed' },
    ])
    expect(botOptions(Object.values(bots)).map((o) => o.value)).toEqual(['b1', 'b2'])
  })

  it('joins bot names, leaving deleted bots out', () => {
    expect(botNames(['b2', 'gone', 'b1'], bots)).toBe('Zed, Ana')
  })

  it('lists General and the active projects, with an optional "all" first', () => {
    const projects = [
      { id: 'p1', name: 'Shop', archivedAt: null },
      { id: 'p2', name: 'Old', archivedAt: 1 },
    ]
    expect(projectOptions(projects, t)).toEqual([
      { value: GENERAL_PROJECT, label: 'General' },
      { value: 'p1', label: 'Shop' },
    ])
    expect(projectOptions(projects, t, { all: true, includeArchived: true }).map((o) => o.value)).toEqual([
      '',
      GENERAL_PROJECT,
      'p1',
      'p2',
    ])
    expect(projectOptions(projects, t, { all: true })[0]?.label).toBe('All projects')
  })
})
