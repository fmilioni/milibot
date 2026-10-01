import { Language } from '@milibot/shared'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import en from '@/i18n/locales/en'
import ptBR from '@/i18n/locales/pt-BR'

import { localeFor } from './platform-texts'

const DEFAULT_LANGUAGE: Language = 'pt-BR'

const resources = {
  'pt-BR': { translation: localeFor(ptBR) },
  en: { translation: localeFor(en) },
} as const

void i18n.use(initReactI18next).init({
  resources,
  lng: DEFAULT_LANGUAGE,
  fallbackLng: DEFAULT_LANGUAGE,
  interpolation: { escapeValue: false },
})

/** The language the app shows now, as a `Language`. */
export function appLanguage(): Language {
  return Language.safeParse(i18n.language).data ?? DEFAULT_LANGUAGE
}

export function setLanguage(language: Language): void {
  if (i18n.language !== language) void i18n.changeLanguage(language)
  document.documentElement.lang = language
}

export default i18n
