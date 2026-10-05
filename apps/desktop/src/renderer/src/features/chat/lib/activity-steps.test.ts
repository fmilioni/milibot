import { ACTIVITY_STEP_KINDS } from '@milibot/shared'
import i18next, { type TFunction } from 'i18next'
import { beforeAll, describe, expect, it } from 'vitest'

import en from '@/i18n/locales/en'
import ptBR from '@/i18n/locales/pt-BR'

import { failedFileStep, stepDesignName, stepIcon, stepText, stepWatchTarget } from './activity-steps'

// Portuguese on purpose: asserts the pt-BR step texts.

const locales = { 'pt-BR': ptBR, en } as const
let ts: Record<keyof typeof locales, TFunction>

beforeAll(async () => {
  const instance = i18next.createInstance()
  await instance.init({
    lng: 'pt-BR',
    resources: { 'pt-BR': { translation: ptBR }, en: { translation: en } },
    interpolation: { escapeValue: false },
  })
  ts = { 'pt-BR': instance.getFixedT('pt-BR'), en: instance.getFixedT('en') }
})

describe('activity step texts', () => {
  it('has an icon and a human text for every step kind, with or without a detail, in both languages', () => {
    for (const [locale, messages] of Object.entries(locales)) {
      const kinds = (messages as { chat: { activity: { kinds: Record<string, string> } } }).chat.activity
        .kinds
      for (const kind of ACTIVITY_STEP_KINDS) {
        expect(kinds[kind], `${locale} ${kind}`).toBeTypeOf('string')
        if (kinds[kind]?.includes('{{detail}}') && kind !== 'note')
          expect(kinds[`${kind}_empty`], `${locale} ${kind}_empty`).toBeTypeOf('string')
        if (kind !== 'tool') expect(stepIcon(kind), kind).not.toBe(stepIcon('tool'))
        const t = ts[locale as keyof typeof locales]
        for (const detail of ['', '{}', 'true', '[]', '{"a":1}']) {
          const text = stepText({ kind, detail }, t)
          expect(text, `${locale} ${kind} "${detail}"`).not.toMatch(/^$|\{|\}|^true$|\[\]/)
        }
      }
    }
  })

  it('reads team and trivial steps like a person would', () => {
    const t = ts['pt-BR']
    expect(stepText({ kind: 'list_bots', detail: '{}' }, t)).toBe('Consultou a equipe')
    expect(stepText({ kind: 'list_bots', detail: '' }, ts.en)).toBe('Checked the team')
    expect(stepText({ kind: 'bash', detail: 'true' }, t)).toBe('Rodou um comando')
    expect(stepText({ kind: 'bash', detail: 'ls -la' }, t)).toBe('ls -la')
    expect(stepText({ kind: 'ask_bot', detail: '' }, t)).toBe('Perguntou a outro bot')
    expect(stepText({ kind: 'update_bot', detail: 'Iris' }, t)).toBe('Atualizou o bot Iris')
  })

  it('never says a failed memory_forget removed anything', () => {
    const t = ts['pt-BR']
    const step = { kind: 'memory_forget', detail: 'A versão 0.3 acabou.' }
    expect(stepText({ ...step, status: 'ok' }, t)).toBe('Removeu da memória: A versão 0.3 acabou.')
    expect(stepText({ ...step, status: 'error' }, t)).toBe('Não removeu da memória: A versão 0.3 acabou.')
    expect(stepText({ kind: 'memory_forget', detail: '', status: 'error' }, t)).toBe(
      'Não removeu nada da memória',
    )
    expect(stepText({ ...step, status: 'error' }, ts.en)).toBe(
      'Did not remove from memory: A versão 0.3 acabou.',
    )
    expect(stepText({ kind: 'list_bots', detail: '', status: 'error' }, t)).toBe('Consultou a equipe')
  })

  it('falls back to the humanized tool name for kinds the app does not know', () => {
    expect(stepText({ kind: 'some_future_tool', detail: '{"x":1}' }, ts['pt-BR'])).toBe(
      'Usou some future tool',
    )
    expect(stepText({ kind: 'NotebookRead', detail: '' }, ts.en)).toBe('Used Notebook Read')
  })
})

describe('step helpers', () => {
  it('links only steps that can be watched: the screen or the design, never the terminal', () => {
    expect(stepWatchTarget('click')).toBe('screen')
    expect(stepWatchTarget('browser_navigate')).toBe('screen')
    expect(stepWatchTarget('design_write_frame')).toBe('design')
    expect(stepWatchTarget('design_list')).toBeNull()
    expect(stepWatchTarget('bash')).toBeNull()
    expect(stepDesignName({ kind: 'design_edit_frame', detail: 'Calculator · Desktop' })).toBe('Calculator')
    expect(stepDesignName({ kind: 'bash', detail: 'ls' })).toBeNull()
  })

  it('names failed file steps and the tool names models borrow', () => {
    expect(failedFileStep({ kind: 'file_edit', detail: '/workspace/app/src/a.ts', status: 'error' })).toBe(
      'file_edit',
    )
    expect(failedFileStep({ kind: 'file_edit', detail: '/workspace/app/src/a.ts', status: 'ok' })).toBeNull()
    expect(failedFileStep({ kind: 'Write', detail: '/workspace/a.ts', status: 'error' })).toBe('file_write')
    expect(stepText({ kind: 'write', detail: '' }, ts.en)).toBe(
      stepText({ kind: 'file_write', detail: '' }, ts.en),
    )
    expect(stepText({ kind: 'tool', detail: 'write' }, ts.en)).toBe(
      stepText({ kind: 'file_write', detail: '' }, ts.en),
    )
  })
})
