import type { OfficeStatus } from '@milibot/shared'
import i18next, { type TFunction } from 'i18next'
import { beforeAll, describe, expect, it } from 'vitest'

import en from '@/i18n/locales/en'
import ptBR from '@/i18n/locales/pt-BR'

import { officeStatusView } from './legacy-office'

// Portuguese on purpose: asserts the pt-BR status texts.

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

const status = (patch: Partial<OfficeStatus>): OfficeStatus => ({
  enabled: true,
  state: 'installed',
  phase: null,
  progress: null,
  error: null,
  installMb: 360,
  ...patch,
})

describe('"Old Office files" status line', () => {
  it('shows the install progress, the wait for the VM and the result', () => {
    expect(officeStatusView(status({ enabled: false, state: 'off' }), t)).toBeNull()
    expect(officeStatusView(status({ state: 'waiting_vm' }), t)).toMatchObject({
      tone: 'warning',
      text: 'Vai instalar quando a máquina ligar',
    })
    expect(
      officeStatusView(status({ state: 'installing', phase: 'downloading', progress: 0.421 }), t),
    ).toEqual({
      tone: 'progress',
      text: 'Instalando o LibreOffice na máquina… 42%',
      progress: 0.421,
      retry: false,
    })
    expect(officeStatusView(status({ state: 'installing' }), t)?.text).toBe(
      'Instalando o LibreOffice na máquina…',
    )
    expect(officeStatusView(status({ state: 'installed' }), tEn)?.text).toBe(
      'LibreOffice installed · the bots can read these files',
    )
    expect(officeStatusView(status({ state: 'error', error: 'apt-get update failed' }), t)).toMatchObject({
      tone: 'danger',
      retry: true,
    })
    expect(
      officeStatusView(status({ enabled: false, state: 'removing', phase: 'removing', progress: 0.3 }), t)
        ?.text,
    ).toBe('Removendo o LibreOffice da máquina… 30%')
  })
})
