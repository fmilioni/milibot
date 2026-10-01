import { SKILL_LIMITS, SKILL_NAME_PATTERN } from '@milibot/shared'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { apiErrorReason } from '@/lib/errors'
import { Button } from '@/ui/Button'
import { Modal } from '@/ui/Modal'
import { FieldLabel, TextArea, TextInput } from '@/ui/TextInput'

import { useSkillsStore } from './store'

/** "New skill": name, when to use it and the instructions; saved as a SKILL.md in the skills folder. */
export function NewSkillDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const create = useSkillsStore((s) => s.create)
  const openSkill = useSkillsStore((s) => s.openSkill)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameValid = SKILL_NAME_PATTERN.test(name) && name.length <= SKILL_LIMITS.nameLength
  const valid = nameValid && description.trim() !== '' && body.trim() !== ''

  const submit = async () => {
    if (!valid || saving) return
    setSaving(true)
    setError(null)
    try {
      const skill = await create(workspaceId, { name, description: description.trim(), body })
      onClose()
      openSkill(skill.id)
    } catch (err) {
      setError(apiErrorReason(err) === 'name_taken' ? t('skills.newDialog.nameTaken') : t('toast.error'))
      setSaving(false)
    }
  }

  return (
    <Modal
      title={t('skills.newDialog.title')}
      description={t('skills.newDialog.description')}
      width={560}
      onClose={onClose}
      closeLabel={t('common.cancel')}
    >
      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor="skill-name" hint={t('skills.newDialog.nameHint')}>
          {t('skills.newDialog.name')}
        </FieldLabel>
        <TextInput
          id="skill-name"
          data-autofocus
          value={name}
          maxLength={SKILL_LIMITS.nameLength}
          placeholder={t('skills.newDialog.namePlaceholder')}
          onChange={(e) =>
            setName(
              e.target.value
                .toLowerCase()
                .replace(/[^a-z0-9-]/g, '-')
                .replace(/-{2,}/g, '-'),
            )
          }
          className="font-mono"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor="skill-description">{t('skills.newDialog.whenToUse')}</FieldLabel>
        <TextArea
          id="skill-description"
          rows={2}
          value={description}
          maxLength={SKILL_LIMITS.descriptionLength}
          placeholder={t('skills.newDialog.whenToUsePlaceholder')}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor="skill-body">{t('skills.newDialog.instructions')}</FieldLabel>
        <TextArea
          id="skill-body"
          rows={8}
          value={body}
          placeholder={t('skills.newDialog.instructionsPlaceholder')}
          onChange={(e) => setBody(e.target.value)}
          className="font-mono text-sm"
        />
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" disabled={!valid || saving} onClick={() => void submit()}>
          {t('skills.newDialog.create')}
        </Button>
      </div>
    </Modal>
  )
}
