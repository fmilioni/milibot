import { Bot, FolderPlus, Plus, Users } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useAppStore } from '@/features/workspace/store'
import { Menu } from '@/ui/Menu'
import { Tooltip } from '@/ui/Tooltip'

export function NewMenu() {
  const { t } = useTranslation()
  const setModal = useAppStore((s) => s.setModal)
  const hasBots = useAppStore((s) => Object.keys(s.bots).length > 0)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const open = rect !== null

  return (
    <>
      <Tooltip content={open ? null : t('sidebar.newMenu')}>
        <button
          data-menu
          type="button"
          onClick={(e) => setRect(open ? null : e.currentTarget.getBoundingClientRect())}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t('sidebar.newMenu')}
          className="no-drag focus-ring flex size-7 items-center justify-center rounded-[7px] bg-surface-3 text-fg hover:brightness-95 dark:hover:brightness-110"
        >
          <Plus size={15} />
        </button>
      </Tooltip>
      {rect && (
        <Menu
          x={rect.right - 190}
          y={rect.bottom + 6}
          width={190}
          label={t('sidebar.newMenu')}
          onClose={() => setRect(null)}
          entries={[
            {
              key: 'bot',
              label: t('sidebar.newBot'),
              icon: <Bot size={14} />,
              onSelect: () => setModal({ type: 'newBot' }),
            },
            {
              key: 'group',
              label: t('sidebar.newGroup'),
              icon: <Users size={14} />,
              disabled: !hasBots,
              onSelect: () => setModal({ type: 'newGroup' }),
            },
            {
              key: 'section',
              label: t('sidebar.newSection'),
              icon: <FolderPlus size={14} />,
              onSelect: () => setModal({ type: 'newSection' }),
            },
          ]}
        />
      )}
    </>
  )
}
