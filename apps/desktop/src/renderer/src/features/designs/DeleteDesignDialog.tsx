import { useTranslation } from 'react-i18next'

import { useDesignStore } from '@/features/canvas/store'
import { ConfirmDialog } from '@/ui/Confirm'

export function DeleteDesignDialog({
  workspaceId,
  designId,
  name,
  onClose,
  onDeleted,
}: {
  workspaceId: string
  designId: string
  name: string
  onClose: () => void
  onDeleted?: () => void
}) {
  const { t } = useTranslation()
  const deleteDesign = useDesignStore((s) => s.deleteDesign)
  return (
    <ConfirmDialog
      title={t('canvas.delete.title', { name })}
      description={t('canvas.delete.description')}
      confirmLabel={t('canvas.delete.confirm')}
      onConfirm={() =>
        deleteDesign(workspaceId, designId).then(() => {
          onClose()
          onDeleted?.()
        })
      }
      onClose={onClose}
    />
  )
}
