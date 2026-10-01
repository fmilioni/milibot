import i18next, { type TFunction } from 'i18next'
import { beforeAll, describe, expect, it } from 'vitest'

import en from '@/i18n/locales/en'
import ptBR from '@/i18n/locales/pt-BR'

import { botStatusLabel, isBusyStatus, nextStatusDetail, statusActivity, waitingForUser } from './bot-status'

// Portuguese on purpose: asserts the pt-BR status labels.

let t: TFunction
let tEn: TFunction

beforeAll(async () => {
  const instance = i18next.createInstance()
  await instance.init({
    lng: 'pt-BR',
    resources: { 'pt-BR': { translation: ptBR }, en: { translation: en } },
    interpolation: { escapeValue: false },
  })
  t = instance.getFixedT('pt-BR')
  tEn = instance.getFixedT('en')
})

describe('botStatusLabel', () => {
  const d = (detail: string, targetBotId?: string) => ({ detail, targetBotId })

  it('reads a bot blocked on a password or a question as waiting for the user', () => {
    expect(botStatusLabel('working', d('request_secret'), t)).toBe('Aguardando você…')
    expect(botStatusLabel('working', d('mcp__milibot__ask_user'), tEn)).toBe('Waiting for you…')
    expect(waitingForUser('working', d('request_secret'))).toBe('secret')
    expect(waitingForUser('working', d('mcp__milibot__ask_user'))).toBe('question')
    expect(waitingForUser('idle', d('ask_user'))).toBeNull()
    expect(waitingForUser('working', d('bash'))).toBeNull()
    expect(nextStatusDetail(d('ask_user'), { status: 'thinking' })).toBeUndefined()
    expect(nextStatusDetail(d('bash'), { status: 'thinking' })).toEqual(d('bash'))
  })

  it('reads a busy bot without a known activity as "Working…"', () => {
    for (const status of ['thinking', 'working', 'talking', 'effort']) {
      expect(isBusyStatus(status)).toBe(true)
      expect(botStatusLabel(status, null, t)).toBe('Trabalhando…')
    }
    expect(botStatusLabel('working', undefined, tEn)).toBe('Working…')
  })

  it('keeps idle and paused apart', () => {
    expect(isBusyStatus('idle')).toBe(false)
    expect(isBusyStatus('paused')).toBe(false)
    expect(botStatusLabel('idle', d('bash'), t)).toBe('Disponível')
    expect(botStatusLabel('paused', null, t)).toBe('Pausado')
    expect(botStatusLabel(undefined, null, t)).toBe('Disponível')
  })

  it('says "using the computer" for every computer action', () => {
    for (const kind of ['click', 'type', 'key', 'scroll', 'screenshot', 'computer_batch', 'drag', 'wait']) {
      expect(botStatusLabel('working', d(kind), t)).toBe('Utilizando o computador…')
      expect(botStatusLabel('working', d(kind), tEn)).toBe('Using the computer…')
    }
    expect(botStatusLabel('effort', d('mcp__milibot__computer'), t)).toBe('Utilizando o computador…')
  })

  it('says "browsing the web" for the browser tools', () => {
    for (const kind of [
      'browser_snapshot',
      'browser_click',
      'browser_tab_new',
      'mcp__milibot__browser_navigate',
    ]) {
      expect(botStatusLabel('working', d(kind), t)).toBe('Navegando na web…')
      expect(botStatusLabel('working', d(kind), tEn)).toBe('Browsing the web…')
    }
  })

  it('has step texts for the browser tools, with and without a detail', () => {
    const tr = t as unknown as (key: string, options?: object) => string
    const step = (kind: string, detail?: string) =>
      tr(`chat.activity.kinds.${kind}${detail === undefined ? '_empty' : ''}`, { detail })
    expect(step('browser_snapshot', 'Inbox (Gmail)')).toBe('Leu a página: Inbox (Gmail)')
    expect(step('browser_snapshot')).toBe('Leu a página')
    expect(step('browser_click', 'Archive')).toBe('Clicou em “Archive”')
    expect(step('browser_navigate', 'mail.google.com')).toBe('Abriu mail.google.com')
  })

  it('humanizes the other tool kinds', () => {
    expect(botStatusLabel('working', d('bash'), t)).toBe('Usando o terminal…')
    expect(botStatusLabel('working', d('Bash'), tEn)).toBe('Using the terminal…')
    expect(botStatusLabel('working', d('file_edit'), t)).toBe('Mexendo em arquivos…')
    expect(botStatusLabel('working', d('Grep'), t)).toBe('Mexendo em arquivos…')
    expect(botStatusLabel('working', d('WebSearch'), t)).toBe('Pesquisando na web…')
    expect(botStatusLabel('working', d('history_search'), t)).toBe('Consultando a memória…')
    expect(botStatusLabel('working', d('memory_save'), t)).toBe('Consultando a memória…')
    expect(botStatusLabel('working', d('repo_checkout'), t)).toBe('Trabalhando no repositório…')
  })

  it('names the bot being messaged', () => {
    const bots = { b2: { name: 'Iris' } }
    expect(botStatusLabel('working', d('ask_bot', 'b2'), t, bots)).toBe('Conversando com Iris…')
    expect(botStatusLabel('working', d('message_bot', 'b2'), tEn, bots)).toBe('Talking to Iris…')
    expect(botStatusLabel('working', d('ask_bot', 'gone'), t, bots)).toBe('Conversando com outro bot…')
  })

  it('never shows raw ids', () => {
    expect(statusActivity('SomeNewTool')).toBeNull()
    expect(statusActivity('  ')).toBeNull()
    expect(botStatusLabel('working', d('SomeNewTool'), t)).toBe('Trabalhando…')
    expect(botStatusLabel('working', d('opening Chrome'), t)).toBe('Trabalhando…')
  })

  it('keeps the last activity while the bot thinks between steps', () => {
    let detail = nextStatusDetail(undefined, { status: 'working', detail: 'click' })
    detail = nextStatusDetail(detail, { status: 'thinking' })
    expect(botStatusLabel('thinking', detail, t)).toBe('Utilizando o computador…')
    expect(nextStatusDetail(detail, { status: 'talking' })).toBeUndefined()
    expect(nextStatusDetail(detail, { status: 'idle' })).toBeUndefined()
    expect(nextStatusDetail(detail, { status: 'working', detail: 'ask_bot', targetBotId: 'b2' })).toEqual({
      detail: 'ask_bot',
      targetBotId: 'b2',
    })
  })
})
