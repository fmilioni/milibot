import type { Bot } from '@milibot/shared'
import { LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { Button } from '@/ui/Button'
import { Modal } from '@/ui/Modal'
import { FieldLabel, TextInput } from '@/ui/TextInput'

import { useTeachStore } from './teach-store'

/** Asks what is going to be taught, then takes the screen and starts recording. */
export function TeachStartDialog({
  bot,
  conversationId,
  userHasControl,
  onClose,
}: {
  bot: Bot
  conversationId: string | null
  userHasControl: boolean
  onClose: () => void
}) {
  const { t } = useTranslation()
  const start = useTeachStore((s) => s.start)
  const workspaceId = useWorkspaceId()
  const showToast = useAppStore((s) => s.showToast)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    try {
      await start({ workspaceId, botId: bot.id, conversationId, name: name.trim(), userHasControl })
      onClose()
    } catch {
      showToast('error')
      setBusy(false)
    }
  }
  return (
    <Modal
      title={t('teach.start.title', { name: bot.name })}
      description={t('teach.start.description', { name: bot.name })}
      width={440}
      onClose={onClose}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="flex flex-col gap-1.5">
          <FieldLabel>{t('teach.start.name')}</FieldLabel>
          <TextInput
            data-autofocus
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('teach.start.namePlaceholder')}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {busy && <LoaderCircle size={13} className="animate-spin motion-reduce:animate-none" />}
            {t('teach.start.begin')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
