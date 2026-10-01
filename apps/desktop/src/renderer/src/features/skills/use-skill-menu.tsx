import type { Skill } from '@milibot/shared'
import { Copy, PanelRightOpen, RefreshCw, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { toastOnError, useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import type { MenuEntry } from '@/ui/Menu'

import { useSkillsStore } from './store'

/**
 * The "⋯" menu of a skill: open (the list only), duplicate, update from its source, delete. `onUpdate`
 * replaces the default update (null hides it); `onDelete` asks for the confirmation.
 */
export function useSkillMenu(
  skill: Pick<Skill, 'id' | 'source' | 'error' | 'editable'>,
  {
    withOpen = false,
    onUpdate,
    onDelete,
  }: { withOpen?: boolean; onUpdate?: (() => void) | null; onDelete: () => void },
): MenuEntry[] {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const showToast = useAppStore((s) => s.showToast)
  const duplicate = useSkillsStore((s) => s.duplicate)
  const updateSource = useSkillsStore((s) => s.updateSource)
  const openSkill = useSkillsStore((s) => s.openSkill)
  const update =
    onUpdate === undefined
      ? () =>
          void toastOnError(updateSource(workspaceId, skill.id, true).then(() => showToast('skillUpdated')))
      : onUpdate

  return [
    ...(withOpen
      ? [
          {
            key: 'open',
            label: t('skills.menu.open'),
            icon: <PanelRightOpen size={14} />,
            onSelect: () => openSkill(skill.id),
          },
        ]
      : []),
    ...(skill.source !== 'taught' && !skill.error
      ? [
          {
            key: 'duplicate',
            label: t(skill.editable ? 'skills.menu.duplicate' : 'skills.menu.duplicateToEdit'),
            icon: <Copy size={14} />,
            onSelect: () =>
              void toastOnError(duplicate(workspaceId, skill.id).then((copy) => openSkill(copy.id))),
          },
        ]
      : []),
    ...(skill.source === 'import' && update
      ? [{ key: 'update', label: t('skills.menu.update'), icon: <RefreshCw size={14} />, onSelect: update }]
      : []),
    ...(skill.editable
      ? [
          { type: 'separator' as const, key: 'sep' },
          {
            key: 'delete',
            label: t('skills.menu.delete'),
            icon: <Trash2 size={14} />,
            danger: true,
            onSelect: onDelete,
          },
        ]
      : []),
  ]
}
