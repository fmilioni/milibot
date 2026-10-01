import { useTranslation } from 'react-i18next'

import { useDesignStore } from '@/features/canvas/store'
import { RenameDialog } from '@/ui/RenameDialog'

export function RenameDesignDialog({
  workspaceId,
  designId,
  name,
  onClose,
}: {
  workspaceId: string
  designId: string
  name: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const renameDesign = useDesignStore((s) => s.renameDesign)
  return (
    <RenameDialog
      title={t('canvas.rename.title')}
      label={t('canvas.rename.label')}
      initial={name}
      maxLength={120}
      onSave={(next) => renameDesign(workspaceId, designId, next)}
      errorText={() => t('toast.error')}
      onClose={onClose}
    />
  )
}
