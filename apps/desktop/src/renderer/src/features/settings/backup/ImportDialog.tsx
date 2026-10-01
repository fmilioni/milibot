import type { AvatarColor, BackupInfo } from '@milibot/shared'
import { Upload } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { importWorkspace } from '@/features/settings/api'
import { useApiMutation } from '@/features/workspace/use-api-mutation'
import { apiErrorReason } from '@/lib/errors'
import { formatBytes } from '@/lib/format'
import { Button } from '@/ui/Button'
import { ColorSwatches } from '@/ui/ColorSwatches'
import { Modal } from '@/ui/Modal'
import { TextInput } from '@/ui/TextInput'

export function ImportDialog({
  path,
  info,
  onClose,
}: {
  path: string
  info: BackupInfo
  onClose: () => void
}) {
  const { t, i18n } = useTranslation()
  const [name, setName] = useState(
    info.workspaceName ? t('backup.importedName', { name: info.workspaceName }) : '',
  )
  const [color, setColor] = useState<AvatarColor>('teal')
  const [error, setError] = useState<string | null>(null)
  const importing = useApiMutation(() => importWorkspace({ path, name: name.trim(), color }), {
    errorToast: false,
  })
  const busy = importing.busy
  const date = info.exportedAt ? new Date(info.exportedAt) : null
  const submit = async () => {
    if (!name.trim() || busy) return
    setError(null)
    try {
      const workspace = await importing.run()
      if (!workspace) return
      onClose()
      void window.milibot.openWorkspaceWindow(workspace.id)
    } catch (err) {
      const reason = apiErrorReason(err)
      setError(reason ? t(`backup.errors.${reason}`, { defaultValue: t('toast.error') }) : t('toast.error'))
    }
  }
  return (
    <Modal title={t('backup.importTitle')} width={500} onClose={onClose} closeLabel={t('common.close')}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="flex flex-col gap-1 rounded-[10px] bg-surface-3/60 px-3.5 py-3 text-sm leading-[17px] text-fg-secondary">
          <span className="text-base font-semibold text-fg">
            {info.workspaceName || path.split(/[\\/]/).pop()}
          </span>
          <span>
            {[
              date ? t('backup.exportedAt', { date: date.toLocaleString(i18n.language) }) : null,
              t('backup.bots', { count: info.bots }),
              info.workspaceBytes !== null
                ? t('backup.withWorkspace', { size: formatBytes(info.workspaceBytes, i18n.language) })
                : t('backup.withoutWorkspace'),
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="import-name" className="text-sm font-medium text-fg-secondary">
            {t('backup.importName')}
          </label>
          <TextInput
            id="import-name"
            data-autofocus
            value={name}
            maxLength={64}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <ColorSwatches
          value={color}
          onChange={setColor}
          label={t('settings.general.color')}
          colorLabel={(c) => t(`colors.${c}`)}
          size={18}
          gap={7}
        />
        <p className="text-sm leading-[17px] text-fg-secondary">
          {info.workspaceBytes !== null ? t('backup.importNoteWorkspace') : t('backup.importNote')}
        </p>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" disabled={busy || !name.trim()}>
            <Upload size={13} />
            {busy ? t('backup.importing') : t('backup.import')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
