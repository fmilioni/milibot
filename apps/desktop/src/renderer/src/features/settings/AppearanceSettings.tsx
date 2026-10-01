import { Language, ThemePreference } from '@milibot/shared'
import { useTranslation } from 'react-i18next'

import { useAppStore } from '@/features/workspace/store'
import { useSystemReducedMotion } from '@/hooks/use-system-reduced-motion'
import { Segmented } from '@/ui/Segmented'
import { Switch } from '@/ui/Switch'

export function AppearanceSettings() {
  const { t } = useTranslation()
  const settings = useAppStore((s) => s.appSettings)
  const update = useAppStore((s) => s.updateAppSettings)
  const systemReduce = useSystemReducedMotion()
  const reduce = settings.reduceMotion ?? systemReduce
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <span className="text-sm font-semibold text-fg-secondary">{t('panels.settings.language')}</span>
        <Segmented
          label={t('panels.settings.language')}
          value={settings.language}
          options={Language.options.map((value) => ({
            value,
            label: t(`panels.settings.languages.${value}`),
          }))}
          onChange={(language) => void update({ language })}
        />
      </section>
      <section className="flex flex-col gap-2">
        <span className="text-sm font-semibold text-fg-secondary">{t('panels.settings.theme')}</span>
        <Segmented
          label={t('panels.settings.theme')}
          value={settings.theme}
          options={ThemePreference.options.map((value) => ({
            value,
            label: t(`panels.settings.themes.${value}`),
          }))}
          onChange={(theme) => void update({ theme })}
        />
      </section>
      <section className="flex flex-col gap-2">
        <span className="text-sm font-semibold text-fg-secondary">{t('panels.settings.motion')}</span>
        <div className="flex flex-col rounded-[10px] border border-border bg-surface-2">
          <label className="flex items-center gap-3 border-b border-border px-3.5 py-[11px]">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-base text-fg">{t('panels.settings.animateEyes')}</span>
              <span className="text-xs text-fg-muted">{t('panels.settings.animateEyesHint')}</span>
            </span>
            <Switch
              checked={settings.animateEyes}
              label={t('panels.settings.animateEyes')}
              onChange={(animateEyes) => void update({ animateEyes })}
            />
          </label>
          <label className="flex items-center gap-3 px-3.5 py-[11px]">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-base text-fg">{t('panels.settings.reduceMotion')}</span>
              <span className="text-xs text-fg-muted">{t('panels.settings.reduceMotionHint')}</span>
            </span>
            <Switch
              checked={reduce}
              label={t('panels.settings.reduceMotion')}
              onChange={(value) => void update({ reduceMotion: value === systemReduce ? null : value })}
            />
          </label>
        </div>
      </section>
    </div>
  )
}
