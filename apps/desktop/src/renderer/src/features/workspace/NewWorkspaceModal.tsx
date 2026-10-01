import type { AvatarColor, CloseBehavior } from '@milibot/shared'
import { ArrowRight, Check } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/cn'
import { Button } from '@/ui/Button'
import { ColorSwatches } from '@/ui/ColorSwatches'
import { Modal } from '@/ui/Modal'
import { FieldLabel, TextInput } from '@/ui/TextInput'

import { useAppStore, useCurrentWorkspace } from './store'
import { WorkspaceBadge } from './WorkspaceBadge'

type CopyOption = 'providers' | 'keys' | 'vmSize'

export function NewWorkspaceModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const current = useCurrentWorkspace()
  const createWorkspace = useAppStore((s) => s.createWorkspace)
  const [name, setName] = useState('')
  const [color, setColor] = useState<AvatarColor>('teal')
  const [copy, setCopy] = useState<Record<CopyOption, boolean>>({
    providers: true,
    keys: false,
    vmSize: true,
  })
  const [closeBehavior, setCloseBehavior] = useState<CloseBehavior>('keep_running')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    setError(false)
    try {
      const copying = current && (copy.providers || copy.vmSize)
      await createWorkspace({
        name: name.trim(),
        color,
        closeBehavior,
        ...(copying
          ? {
              copyFrom: {
                workspaceId: current.id,
                providers: copy.providers,
                keys: copy.providers && copy.keys,
                vmSize: copy.vmSize,
              },
            }
          : {}),
      })
      onClose()
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  const copyRows: { key: CopyOption; label: string; hint: string }[] = [
    { key: 'providers', label: t('newWorkspace.copyProviders'), hint: t('newWorkspace.copyProvidersHint') },
    { key: 'keys', label: t('newWorkspace.copyKeys'), hint: t('newWorkspace.copyKeysHint') },
    { key: 'vmSize', label: t('newWorkspace.copyVm'), hint: t('newWorkspace.copyVmHint') },
  ]

  return (
    <Modal
      title={t('newWorkspace.title')}
      description={t('newWorkspace.description')}
      width={500}
      onClose={onClose}
      showClose={false}
    >
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-[18px]">
        <div className="flex items-end gap-3">
          <WorkspaceBadge name={name || '?'} color={color} size={40} />
          <div className="flex flex-1 flex-col gap-[5px]">
            <FieldLabel htmlFor="new-ws-name">{t('newWorkspace.name')}</FieldLabel>
            <TextInput
              id="new-ws-name"
              data-autofocus
              value={name}
              maxLength={64}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('newWorkspace.namePlaceholder')}
            />
          </div>
        </div>
        <ColorSwatches
          value={color}
          onChange={setColor}
          label={t('newWorkspace.color')}
          colorLabel={(c) => t(`colors.${c}`)}
          size={20}
          gap={8}
        />
        {current && (
          <fieldset className="flex flex-col gap-2 rounded-[10px] border border-border bg-surface p-3.5">
            <legend className="float-left mb-0.5 text-sm font-semibold text-fg">
              {t('newWorkspace.copyFrom', { name: current.name })}
            </legend>
            {copyRows.map((row) => {
              const disabled = row.key === 'keys' && !copy.providers
              return (
                <label key={row.key} className={cn('flex items-center gap-2.5', disabled && 'opacity-50')}>
                  <input
                    type="checkbox"
                    className="peer sr-only"
                    disabled={disabled}
                    checked={copy[row.key] && !disabled}
                    onChange={(e) => setCopy({ ...copy, [row.key]: e.target.checked })}
                  />
                  <span
                    className={cn(
                      'flex size-4 shrink-0 items-center justify-center rounded peer-focus-visible:ring-2 peer-focus-visible:ring-accent',
                      copy[row.key] && !disabled ? 'bg-accent text-on-accent' : 'border border-fg-muted',
                    )}
                    aria-hidden
                  >
                    {copy[row.key] && !disabled && <Check size={11} strokeWidth={3} />}
                  </span>
                  <span className="text-base text-fg">{row.label}</span>
                  <span className="text-xs text-fg-muted">{row.hint}</span>
                </label>
              )
            })}
          </fieldset>
        )}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium text-fg-secondary">
            {t('newWorkspace.closeTitle')}
          </legend>
          {(['keep_running', 'suspend_vm'] as const).map((value) => (
            <label key={value} className="flex items-center gap-2 text-base text-fg">
              <input
                type="radio"
                name="close-behavior"
                className="peer sr-only"
                checked={closeBehavior === value}
                onChange={() => setCloseBehavior(value)}
              />
              <span
                className={cn(
                  'size-3.5 shrink-0 rounded-full peer-focus-visible:ring-2 peer-focus-visible:ring-accent',
                  closeBehavior === value ? 'border-4 border-accent' : 'border border-fg-muted',
                )}
                aria-hidden
              />
              {t(`newWorkspace.close.${value}`)}
            </label>
          ))}
        </fieldset>
        {error && <div className="text-sm text-danger">{t('newWorkspace.failed')}</div>}
        <div className="flex justify-end gap-2.5">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || busy}>
            {t('newWorkspace.create')}
            <ArrowRight size={13} />
          </Button>
        </div>
      </form>
    </Modal>
  )
}
