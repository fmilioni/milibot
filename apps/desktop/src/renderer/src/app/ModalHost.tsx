import { Check } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import { NewBotModal } from '@/features/bots/NewBotModal'
import { describeConversation } from '@/features/chat/lib/conversation'
import { NewWorkspaceModal } from '@/features/workspace/NewWorkspaceModal'
import { useAppStore } from '@/features/workspace/store'
import { cn } from '@/lib/cn'
import { Button } from '@/ui/Button'
import { Modal } from '@/ui/Modal'
import { FieldLabel, TextInput } from '@/ui/TextInput'

export function ModalHost() {
  const modal = useAppStore((s) => s.modal)
  const setModal = useAppStore((s) => s.setModal)
  const close = () => setModal(null)
  if (!modal) return null
  switch (modal.type) {
    case 'newBot':
      return <NewBotModal onClose={close} />
    case 'newWorkspace':
      return <NewWorkspaceModal onClose={close} />
    case 'newGroup':
      return <NewGroupModal onClose={close} />
    case 'newSection':
      return <NewSectionModal onClose={close} moveConversationId={modal.moveConversationId} />
    case 'confirmDelete':
      return <ConfirmDeleteModal onClose={close} conversationId={modal.conversationId} />
  }
}

function NewSectionModal({
  onClose,
  moveConversationId,
}: {
  onClose: () => void
  moveConversationId?: string
}) {
  const { t } = useTranslation()
  const createSection = useAppStore((s) => s.createSection)
  const moveConversation = useAppStore((s) => s.moveConversation)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    try {
      const section = await createSection(name.trim())
      if (moveConversationId)
        await moveConversation(moveConversationId, { pinned: false, sectionId: section.id })
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={t('newSection.title')} width={380} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <div className="flex flex-col gap-[5px]">
          <FieldLabel htmlFor="new-section-name">{t('newSection.name')}</FieldLabel>
          <TextInput
            id="new-section-name"
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('newSection.placeholder')}
          />
        </div>
        <div className="flex justify-end gap-2.5">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || busy}>
            {t('newSection.create')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function NewGroupModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const bots = useAppStore((s) => s.bots)
  const createGroup = useAppStore((s) => s.createGroup)
  const [title, setTitle] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

  const toggle = (id: string) =>
    setSelected((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (selected.length === 0 || busy) return
    setBusy(true)
    setError(false)
    try {
      await createGroup(selected, title.trim() || null)
      onClose()
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={t('newGroup.title')} width={440} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <div className="flex flex-col gap-[5px]">
          <FieldLabel htmlFor="new-group-title">{t('newGroup.name')}</FieldLabel>
          <TextInput
            id="new-group-title"
            value={title}
            maxLength={64}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('newGroup.namePlaceholder')}
          />
        </div>
        <div className="flex flex-col gap-[5px]">
          <FieldLabel>{t('newGroup.members')}</FieldLabel>
          <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto rounded-lg border border-border bg-surface p-1">
            {Object.values(bots).map((bot) => {
              const checked = selected.includes(bot.id)
              return (
                <button
                  key={bot.id}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  onClick={() => toggle(bot.id)}
                  className={cn(
                    'focus-ring flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left',
                    checked ? 'bg-accent-soft' : 'hover:bg-surface-3',
                  )}
                >
                  <BotAvatar avatar={bot.avatar} size={22} animated={false} />
                  <span className="text-base font-semibold text-fg">{bot.name}</span>
                  {bot.label && <span className="text-sm text-fg-muted">{bot.label}</span>}
                  <span className="flex-1" />
                  {checked && <Check size={14} className="text-accent" />}
                </button>
              )
            })}
          </div>
        </div>
        {error && <div className="text-sm text-danger">{t('newGroup.failed')}</div>}
        <div className="flex justify-end gap-2.5">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={selected.length === 0 || busy}>
            {t('newGroup.create')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function ConfirmDeleteModal({ onClose, conversationId }: { onClose: () => void; conversationId: string }) {
  const { t } = useTranslation()
  const conversation = useAppStore((s) => s.conversations[conversationId])
  const bots = useAppStore((s) => s.bots)
  const deleteConversation = useAppStore((s) => s.deleteConversation)
  if (!conversation) return null
  const display = describeConversation(conversation, bots, t('sidebar.groupFallback'))
  const direct = conversation.type === 'direct'
  const lastBot = direct && Object.keys(bots).length <= 1
  return (
    <Modal
      title={
        direct
          ? t('deleteDialog.botTitle', { name: display.title })
          : t('deleteDialog.groupTitle', { name: display.title })
      }
      description={
        lastBot ? t('deleteDialog.lastBot') : direct ? t('deleteDialog.botBody') : t('deleteDialog.groupBody')
      }
      width={420}
      onClose={onClose}
    >
      <div className="flex justify-end gap-2.5">
        <Button onClick={onClose} data-autofocus>
          {t('common.cancel')}
        </Button>
        <Button
          variant="danger"
          disabled={lastBot}
          onClick={() => {
            onClose()
            void deleteConversation(conversationId)
          }}
        >
          {t('deleteDialog.confirm')}
        </Button>
      </div>
    </Modal>
  )
}
