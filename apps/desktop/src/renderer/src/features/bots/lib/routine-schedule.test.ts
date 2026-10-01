import i18next, { type TFunction } from 'i18next'
import { beforeAll, describe, expect, it } from 'vitest'

import en from '@/i18n/locales/en'
import ptBR from '@/i18n/locales/pt-BR'

import {
  DEFAULT_DRAFT,
  describeSchedule,
  describeWhen,
  draftFromCron,
  draftToCron,
  formatDayMonth,
  previewDraft,
  type ScheduleDraft,
} from './routine-schedule'

// Portuguese on purpose: asserts pt-BR schedule descriptions.

let pt: TFunction
let english: TFunction

beforeAll(async () => {
  const make = async (lng: string) => {
    const instance = i18next.createInstance()
    await instance.init({
      lng,
      resources: { 'pt-BR': { translation: ptBR }, en: { translation: en } },
      interpolation: { escapeValue: false },
    })
    return instance.t
  }
  pt = await make('pt-BR')
  english = await make('en')
})

describe('describeSchedule', () => {
  it('reads like the design in pt-BR', () => {
    const cases: Array<[string, string]> = [
      ['0 8 1 * *', 'Todo dia 1º · 08:00'],
      ['0 10 15 * *', 'Todo dia 15 · 10:00'],
      ['30 18 * * 1-5', 'Seg a sex · 18:30'],
      ['0 8 * * *', 'Todo dia · 08:00'],
      ['0 10 * * 0,6', 'Sáb e dom · 10:00'],
      ['0 9 * * 1', 'Toda segunda · 09:00'],
      ['0 9 * * 6', 'Todo sábado · 09:00'],
      ['0 7 * * 1,3,5', 'Seg, qua, sex · 07:00'],
      ['0 */2 * * *', 'A cada 2 horas'],
      ['0 * * * *', 'A cada hora'],
      ['15 */3 * * *', 'A cada 3 horas · aos 15 min'],
      ['*/15 * * * *', 'A cada 15 minutos'],
      ['0 8 1-7 * 1', 'Personalizada · 0 8 1-7 * 1'],
    ]
    for (const [cron, text] of cases) expect(describeSchedule(cron, 'pt-BR', pt)).toBe(text)
  })

  it('reads naturally in English', () => {
    expect(describeSchedule('0 8 1 * *', 'en', english)).toBe('Every month on the 1st · 08:00')
    expect(describeSchedule('0 8 22 * *', 'en', english)).toBe('Every month on the 22nd · 08:00')
    expect(describeSchedule('30 18 * * 1-5', 'en', english)).toBe('Mon–Fri · 18:30')
    expect(describeSchedule('0 9 * * 2', 'en', english)).toBe('Every Tuesday · 09:00')
    expect(describeSchedule('0 */2 * * *', 'en', english)).toBe('Every 2 hours')
  })
})

describe('describeWhen', () => {
  const now = new Date(2026, 8, 26, 10, 0).getTime()
  it('says today/tomorrow, else the date', () => {
    expect(describeWhen(new Date(2026, 8, 26, 18, 30).getTime(), 'pt-BR', pt, now)).toBe('hoje 18:30')
    expect(describeWhen(new Date(2026, 8, 27, 8, 0).getTime(), 'pt-BR', pt, now)).toBe('amanhã 08:00')
    expect(describeWhen(new Date(2026, 9, 1, 8, 0).getTime(), 'pt-BR', pt, now)).toMatch(
      /^qui, 1 de out 08:00$/,
    )
    expect(describeWhen(new Date(2027, 0, 1, 8, 0).getTime(), 'en', english, now)).toMatch(/2027/)
  })

  it('formats the card date with an ordinal first day', () => {
    expect(formatDayMonth(new Date(2026, 9, 1).getTime(), 'pt-BR', pt)).toBe('1º de outubro')
    expect(formatDayMonth(new Date(2026, 9, 15).getTime(), 'pt-BR', pt)).toBe('15 de outubro')
    expect(formatDayMonth(new Date(2026, 9, 1).getTime(), 'en', english)).toBe('October 1st')
  })
})

describe('schedule builder', () => {
  const draft = (patch: Partial<ScheduleDraft>): ScheduleDraft => ({ ...DEFAULT_DRAFT, ...patch })

  it('builds cron from the friendly fields', () => {
    expect(draftToCron(draft({ frequency: 'daily', time: { hour: 8, minute: 0 } }))).toBe('0 8 * * *')
    expect(draftToCron(draft({ frequency: 'weekdays', time: { hour: 18, minute: 30 } }))).toBe(
      '30 18 * * 1-5',
    )
    expect(draftToCron(draft({ frequency: 'weekly', days: [5, 1, 3] }))).toBe('0 9 * * 1,3,5')
    expect(draftToCron(draft({ frequency: 'weekly', days: [0, 1, 2, 3, 4, 5, 6] }))).toBe('0 9 * * *')
    expect(draftToCron(draft({ frequency: 'monthly', day: 1, time: { hour: 8, minute: 0 } }))).toBe(
      '0 8 1 * *',
    )
    expect(draftToCron(draft({ frequency: 'hourly', hours: 4 }))).toBe('0 */4 * * *')
    expect(draftToCron(draft({ frequency: 'minutes', minutes: 15 }))).toBe('*/15 * * * *')
    expect(draftToCron(draft({ frequency: 'custom', cron: ' 0 8 1-7 * 1 ' }))).toBe('0 8 1-7 * 1')
  })

  it('opens existing routines in the matching frequency', () => {
    expect(draftFromCron('30 18 * * 1-5')).toMatchObject({
      frequency: 'weekdays',
      time: { hour: 18, minute: 30 },
    })
    expect(draftFromCron('0 9 * * 1,3')).toMatchObject({ frequency: 'weekly', days: [1, 3] })
    expect(draftFromCron('0 8 1 * *')).toMatchObject({ frequency: 'monthly', day: 1 })
    expect(draftFromCron('0 */2 * * *')).toMatchObject({ frequency: 'hourly', hours: 2 })
    expect(draftFromCron('0 8 1-7 * 1')).toMatchObject({ frequency: 'custom', cron: '0 8 1-7 * 1' })
    for (const cron of ['0 8 * * *', '30 18 * * 1-5', '0 8 1 * *', '0 */2 * * *', '*/15 * * * *']) {
      expect(draftToCron(draftFromCron(cron))).toBe(cron)
    }
  })

  it('previews the next runs or explains an invalid expression', () => {
    const now = new Date(2026, 8, 26, 10, 0).getTime()
    const ok = previewDraft(draft({ frequency: 'monthly', day: 1, time: { hour: 8, minute: 0 } }), now)
    expect('runs' in ok && ok.runs[0]).toBe(new Date(2026, 9, 1, 8, 0).getTime())
    expect(previewDraft(draft({ frequency: 'custom', cron: '0 25 * * *' }), now)).toMatchObject({
      error: expect.stringContaining('hour'),
    })
    expect(previewDraft(draft({ frequency: 'weekly', days: [] }), now)).toHaveProperty('error')
  })
})
