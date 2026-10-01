import type { Avatar, Language } from '@milibot/shared'
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'

import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import { useAppStore } from '@/features/workspace/store'
import { cn } from '@/lib/cn'

/** Positions measured on a 720×900 hero (percent of the panel), size in px, tilt in degrees. */
const FLOATING: Array<{ avatar: Avatar; x: number; y: number; size: number; tilt: number }> = [
  { avatar: { shape: 'arch', color: 'violet', eyes: 'capsule' }, x: 16.7, y: 16.7, size: 64, tilt: 0 },
  { avatar: { shape: 'triangle', color: 'pink', eyes: 'capsule' }, x: 71.3, y: 12.2, size: 59, tilt: -8 },
  { avatar: { shape: 'blob', color: 'green', eyes: 'capsule' }, x: 65.3, y: 21.1, size: 40, tilt: 0 },
  { avatar: { shape: 'drop', color: 'orange', eyes: 'capsule' }, x: 81.9, y: 32.7, size: 64, tilt: 6 },
  { avatar: { shape: 'cloud', color: 'blue', eyes: 'capsule' }, x: 13.3, y: 42.2, size: 56, tilt: 0 },
  { avatar: { shape: 'square', color: 'gray', eyes: 'capsule' }, x: 19.6, y: 62.2, size: 58, tilt: -10 },
  { avatar: { shape: 'hexagon', color: 'teal', eyes: 'capsule' }, x: 77.8, y: 67.9, size: 70, tilt: 8 },
  { avatar: { shape: 'ghost', color: 'amber', eyes: 'capsule' }, x: 45.8, y: 80, size: 48, tilt: 0 },
]

// Portuguese on purpose: each language is named in itself, so it reads right before one is picked.
const LANGUAGES: Array<{ value: Language; label: string }> = [
  { value: 'pt-BR', label: 'Português' },
  { value: 'en', label: 'English' },
]

export function SetupHero() {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.appSettings.language)
  const updateAppSettings = useAppStore((s) => s.updateAppSettings)

  return (
    <section className="drag-region relative flex h-full w-1/2 shrink-0 flex-col items-center justify-center overflow-hidden bg-surface">
      {FLOATING.map((item, i) => (
        <div
          key={item.avatar.shape}
          className="setup-float pointer-events-none absolute"
          style={
            {
              left: `${item.x}%`,
              top: `${item.y}%`,
              '--tilt': `${item.tilt}deg`,
              '--float-duration': `${5 + (i % 4) * 0.9}s`,
              '--float-delay': `${-i * 0.7}s`,
            } as CSSProperties
          }
        >
          <BotAvatar avatar={item.avatar} size={item.size} />
        </div>
      ))}
      <h1 className="relative text-display leading-[1.1] font-bold tracking-[-0.02em] text-fg">Milibot</h1>
      <p className="relative mt-3 max-w-[80%] text-center text-xl text-fg-secondary">{t('setup.tagline')}</p>
      <div
        role="radiogroup"
        aria-label={t('setup.language')}
        className="no-drag absolute bottom-[23px] left-1/2 flex w-[220px] -translate-x-1/2 rounded-lg bg-surface-3 p-[3px]"
      >
        {LANGUAGES.map((option) => {
          const selected = option.value === language
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              lang={option.value}
              onClick={() => void updateAppSettings({ language: option.value })}
              className={cn(
                'focus-ring h-[25px] flex-1 rounded-md text-sm',
                selected ? 'bg-surface-2 font-semibold text-fg shadow-sm' : 'text-fg-secondary hover:text-fg',
              )}
            >
              {option.label}
            </button>
          )
        })}
      </div>
    </section>
  )
}
