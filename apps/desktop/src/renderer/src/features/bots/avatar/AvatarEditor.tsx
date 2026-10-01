import { type Avatar, AVATAR_EYES, AVATAR_SHAPES, randomAvatar } from '@milibot/shared'
import { Shuffle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/cn'
import { ColorSwatches } from '@/ui/ColorSwatches'
import { Tooltip } from '@/ui/Tooltip'

import { BotAvatar } from './BotAvatar'

interface AvatarEditorProps {
  value: Avatar
  onChange: (avatar: Avatar) => void
  variant: 'panel' | 'modal'
  /** Live state of the bot, so the preview blinks/works like the real one. */
  state?: string | null
}

export function AvatarEditor({ value, onChange, variant, state }: AvatarEditorProps) {
  const { t } = useTranslation()
  const panel = variant === 'panel'
  const optionSize = panel ? 36 : 32
  return (
    <div className="flex flex-col items-center gap-3">
      <BotAvatar avatar={value} state={state} size={panel ? 88 : 72} label={t('avatar.preview')} />
      <div className={panel ? '' : 'mt-1'}>
        <ColorSwatches
          value={value.color}
          onChange={(color) => onChange({ ...value, color })}
          label={t('avatar.color')}
          colorLabel={(c) => t(`colors.${c}`)}
          size={panel ? 22 : 20}
          gap={panel ? 10 : 8}
        />
      </div>
      <div role="radiogroup" aria-label={t('avatar.shape')} className="flex" style={{ gap: panel ? 6 : 4 }}>
        {AVATAR_SHAPES.map((shape) => {
          const selected = shape === value.shape
          return (
            <Tooltip key={shape} content={t(`avatar.shapes.${shape}`)}>
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={t(`avatar.shapes.${shape}`)}
                onClick={() => onChange({ ...value, shape })}
                className={cn(
                  'focus-ring flex items-center justify-center border',
                  selected ? 'border-accent bg-accent-soft' : 'border-transparent hover:bg-surface-3',
                )}
                style={{ width: optionSize, height: optionSize, borderRadius: panel ? 8 : 7 }}
              >
                <BotAvatar
                  avatar={{ ...value, shape }}
                  size={optionSize - (panel ? 10 : 8)}
                  animated={false}
                />
              </button>
            </Tooltip>
          )
        })}
      </div>
      {panel && (
        <div role="radiogroup" aria-label={t('avatar.eyes')} className="flex gap-1.5">
          {AVATAR_EYES.map((eyes) => {
            const selected = eyes === value.eyes
            return (
              <button
                key={eyes}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onChange({ ...value, eyes })}
                className={cn(
                  'focus-ring flex h-[30px] items-center gap-1.5 rounded-lg border py-1 pr-2.5 pl-1 text-sm',
                  selected
                    ? 'border-accent bg-accent-soft text-fg'
                    : 'border-border text-fg-secondary hover:bg-surface-3',
                )}
              >
                <BotAvatar avatar={{ ...value, shape: 'square', eyes }} size={22} animated={false} />
                {t(`avatar.eyeStyles.${eyes}`)}
              </button>
            )
          })}
        </div>
      )}
      {panel && (
        <button
          type="button"
          onClick={() => onChange(randomAvatar())}
          className="focus-ring flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-accent hover:bg-accent-soft"
        >
          <Shuffle size={13} />
          {t('avatar.random')}
        </button>
      )}
    </div>
  )
}
