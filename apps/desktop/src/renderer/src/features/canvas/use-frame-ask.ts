import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { frameContextPrefix } from '@/features/canvas/lib/canvas'

import { useDesignStore } from './store'

/** The composer chip of "Ask for a change": the frame and the line the message starts with. */
export function useFrameAsk(conversationId: string) {
  const { t } = useTranslation()
  const ask = useDesignStore((s) => s.asks[conversationId])
  const clearAsk = useDesignStore((s) => s.clearAsk)
  return useMemo(
    () =>
      ask
        ? {
            label: t('canvas.chip', { name: ask.frameName }),
            removeLabel: t('canvas.removeChip'),
            prefix: frameContextPrefix(ask.frameName, ask.designName),
            focusKey: ask.at,
            onClear: () => clearAsk(conversationId),
          }
        : undefined,
    [ask, clearAsk, conversationId, t],
  )
}
