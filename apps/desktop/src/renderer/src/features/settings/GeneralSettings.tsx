import { type CloseBehavior, firstBot, type IdleWatchFallback, type WorkspaceSummary } from '@milibot/shared'
import { FolderOpen, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useAppStore, useCurrentWorkspace } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { WorkspaceBadge } from '@/features/workspace/WorkspaceBadge'
import { useDismiss } from '@/hooks/use-dismiss'
import { useDraft } from '@/hooks/use-draft'
import { shortPath } from '@/lib/platform'
import { Button } from '@/ui/Button'
import { ColorSwatches } from '@/ui/ColorSwatches'
import { ConfirmDialog } from '@/ui/Confirm'
import { Select } from '@/ui/Select'
import { Switch } from '@/ui/Switch'
import { TextInput } from '@/ui/TextInput'

import { AttachmentLimitRow } from './AttachmentLimitRow'
import { BackupRows } from './BackupSection'
import { SettingsCard, SettingsPage, SettingsRow } from './SettingsLayout'
import { useWorkspacePreferences } from './store'

function IconPicker({ workspace }: { workspace: WorkspaceSummary }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(workspace.icon ?? '')
  const ref = useRef<HTMLDivElement>(null)
  const update = useAppStore((s) => s.updateWorkspace)
  useDismiss(ref, open, () => setOpen(false))
  const save = (icon: string | null) => {
    setOpen(false)
    void update(workspace.id, { icon })
  }
  return (
    <div ref={ref} data-menu className="relative">
      <button
        type="button"
        aria-label={t('settings.general.icon')}
        aria-expanded={open}
        onClick={() => {
          setValue(workspace.icon ?? '')
          setOpen(!open)
        }}
        className="focus-ring rounded-[12px] transition hover:brightness-105"
      >
        <WorkspaceBadge name={workspace.name} color={workspace.color} icon={workspace.icon} size={44} />
      </button>
      {open && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            save([...value.trim()].slice(0, 2).join('') || null)
          }}
          className="absolute top-full left-0 z-panel mt-1.5 flex w-64 flex-col gap-2 rounded-xl border border-border bg-surface-2 p-3 shadow-[0_12px_32px_rgba(0,0,0,0.16)]"
        >
          <label htmlFor="ws-icon" className="text-sm font-medium text-fg-secondary">
            {t('settings.general.iconHint')}
          </label>
          <TextInput
            id="ws-icon"
            data-autofocus
            autoFocus
            value={value}
            maxLength={8}
            placeholder={workspace.name.trim().charAt(0).toUpperCase()}
            onChange={(e) => setValue(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => save(null)}>
              {t('settings.general.iconReset')}
            </Button>
            <Button size="sm" variant="primary" type="submit">
              {t('common.save')}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}

export function DeleteWorkspaceDialog({
  workspace,
  onClose,
}: {
  workspace: WorkspaceSummary
  onClose: () => void
}) {
  const { t } = useTranslation()
  const deleteWorkspace = useAppStore((s) => s.deleteWorkspace)
  return (
    <ConfirmDialog
      title={t('settings.general.deleteTitle', { name: workspace.name })}
      body={t('settings.general.deleteBody')}
      typeToConfirm={workspace.name}
      typeLabel={t('settings.general.deleteType', { name: workspace.name })}
      confirmLabel={t('settings.general.deleteConfirm')}
      busyLabel={t('settings.general.deleting')}
      confirmIcon={<Trash2 size={13} />}
      width={480}
      onConfirm={() => deleteWorkspace(workspace.id)}
      onClose={onClose}
    />
  )
}

/**
 * App-wide (not per workspace): the daemon starts when the user logs in. Hidden where the platform has no
 * login item (`getLoginItem` → null).
 */
function ComputerCard() {
  const { t } = useTranslation()
  const showToast = useAppStore((s) => s.showToast)
  const [enabled, setEnabled] = useState<boolean | null | undefined>(undefined)
  useEffect(() => {
    let active = true
    window.milibot
      .getLoginItem()
      .then((value) => active && setEnabled(value))
      .catch(() => active && setEnabled(false))
    return () => {
      active = false
    }
  }, [])
  if (enabled === null) return null
  const change = (value: boolean) => {
    const previous = enabled
    setEnabled(value)
    window.milibot
      .setLoginItem(value)
      .then(setEnabled)
      .catch(() => {
        setEnabled(previous)
        showToast('error')
      })
  }
  return (
    <SettingsCard title={t('settings.general.thisComputer')}>
      <SettingsRow label={t('settings.general.launchAtLogin')} hint={t('settings.general.launchAtLoginHint')}>
        <Switch
          checked={enabled ?? false}
          disabled={enabled === undefined}
          label={t('settings.general.launchAtLogin')}
          onChange={change}
        />
      </SettingsRow>
    </SettingsCard>
  )
}

const IDLE_WATCH_MINUTES = [0, 15, 30, 60, 120, 240]

/** The idle watch: how long a bot may stay stopped with requests set aside before a bot is told, and which. */
function IdleWatchRows() {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const { prefs, loaded, set } = useWorkspacePreferences(workspaceId)
  const bots = useAppStore((s) => s.bots)
  const first = firstBot(Object.values(bots))
  const minutes = IDLE_WATCH_MINUTES.includes(prefs.idleWatchMinutes)
    ? IDLE_WATCH_MINUTES
    : [...IDLE_WATCH_MINUTES, prefs.idleWatchMinutes].sort((a, b) => a - b)
  return (
    <>
      <SettingsRow label={t('settings.general.idleWatch')} hint={t('settings.general.idleWatchHint')}>
        <div className="w-[210px]">
          <Select
            label={t('settings.general.idleWatch')}
            value={String(prefs.idleWatchMinutes)}
            disabled={!loaded}
            options={minutes.map((value) => ({
              value: String(value),
              label: value
                ? t('settings.general.idleWatchAfter', { count: value })
                : t('settings.general.idleWatchOff'),
            }))}
            size="sm"
            tone="surface-2"
            onChange={(value) => void set({ idleWatchMinutes: Number(value) })}
          />
        </div>
      </SettingsRow>
      <SettingsRow label={t('settings.general.idleWatchBot')} hint={t('settings.general.idleWatchBotHint')}>
        <div className="w-[210px]">
          <Select
            label={t('settings.general.idleWatchBot')}
            value={prefs.idleWatchBotId && bots[prefs.idleWatchBotId] ? prefs.idleWatchBotId : ''}
            disabled={!loaded || prefs.idleWatchMinutes === 0}
            options={[
              {
                value: '',
                label: t('settings.general.idleWatchBotFirst', { name: first?.name ?? '' }),
              },
              ...Object.values(bots).map((bot) => ({ value: bot.id, label: bot.name })),
            ]}
            size="sm"
            tone="surface-2"
            onChange={(value) => void set({ idleWatchBotId: value || null })}
          />
        </div>
      </SettingsRow>
      <SettingsRow
        label={t('settings.general.idleWatchFallback')}
        hint={t('settings.general.idleWatchFallbackHint')}
      >
        <div className="w-[210px]">
          <Select
            label={t('settings.general.idleWatchFallback')}
            value={prefs.idleWatchFallback}
            disabled={!loaded || prefs.idleWatchMinutes === 0}
            options={[
              { value: 'next_bot', label: t('settings.general.idleWatchFallbackNextBot') },
              { value: 'user', label: t('settings.general.idleWatchFallbackUser') },
            ]}
            size="sm"
            tone="surface-2"
            onChange={(value) => void set({ idleWatchFallback: value as IdleWatchFallback })}
          />
        </div>
      </SettingsRow>
    </>
  )
}

export function GeneralSettings() {
  const { t } = useTranslation()
  const workspace = useCurrentWorkspace()
  const workspaceId = useWorkspaceId()
  const update = useAppStore((s) => s.updateWorkspace)
  const showToast = useAppStore((s) => s.showToast)
  const { prefs, loaded, set } = useWorkspacePreferences(workspaceId)
  const [name, setName] = useDraft(workspace?.name ?? '')
  const [deleting, setDeleting] = useState(false)

  if (!workspace) return null

  const saveName = () => {
    const trimmed = name.trim()
    if (!trimmed) setName(workspace.name)
    else if (trimmed !== workspace.name) void update(workspace.id, { name: trimmed })
  }

  const closeOptions: Array<{ value: CloseBehavior; label: string; description: string }> = [
    {
      value: 'keep_running',
      label: t('settings.general.close.keep_running'),
      description: t('settings.general.close.keep_runningHint'),
    },
    {
      value: 'suspend_vm',
      label: t('settings.general.close.suspend_vm'),
      description: t('settings.general.close.suspend_vmHint'),
    },
  ]

  return (
    <SettingsPage
      title={t('settings.sections.general')}
      subtitle={t('settings.general.subtitle', { name: workspace.name })}
      width="narrow"
    >
      <SettingsCard title={t('settings.general.identity')}>
        <div className="flex flex-wrap items-center gap-3.5 px-4 pt-1.5 pb-4">
          <IconPicker workspace={workspace} />
          <div className="w-[260px] max-w-full">
            <TextInput
              aria-label={t('settings.general.name')}
              value={name}
              maxLength={64}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setName(workspace.name)
                }
              }}
            />
          </div>
          <ColorSwatches
            value={workspace.color}
            onChange={(color) => void update(workspace.id, { color })}
            label={t('settings.general.color')}
            colorLabel={(color) => t(`colors.${color}`)}
            size={18}
            gap={7}
          />
        </div>
      </SettingsCard>

      <SettingsCard title={t('settings.general.behavior')}>
        <SettingsRow label={t('settings.general.vmAutostart')} hint={t('settings.general.vmAutostartHint')}>
          <Switch
            checked={prefs.vmAutostart}
            disabled={!loaded}
            label={t('settings.general.vmAutostart')}
            onChange={(vmAutostart) => void set({ vmAutostart })}
          />
        </SettingsRow>
        <SettingsRow label={t('settings.general.closeLabel')} hint={t('settings.general.closeHint')}>
          <div className="w-[210px]">
            <Select
              label={t('settings.general.closeLabel')}
              value={workspace.closeBehavior}
              options={closeOptions}
              size="sm"
              tone="surface-2"
              onChange={(closeBehavior) => void update(workspace.id, { closeBehavior })}
            />
          </div>
        </SettingsRow>
        <SettingsRow
          label={t('settings.general.routinesCatchUp')}
          hint={t('settings.general.routinesCatchUpHint')}
        >
          <div className="w-[210px]">
            <Select
              label={t('settings.general.routinesCatchUp')}
              value={prefs.routinesCatchUp}
              disabled={!loaded}
              options={(['once', 'skip'] as const).map((value) => ({
                value,
                label: t(`settings.general.catchUp.${value}`),
                description: t(`settings.general.catchUp.${value}Hint`),
              }))}
              size="sm"
              tone="surface-2"
              onChange={(routinesCatchUp) => void set({ routinesCatchUp })}
            />
          </div>
        </SettingsRow>
        <SettingsRow
          label={t('settings.general.notifications')}
          hint={t('settings.general.notificationsHint')}
        >
          <Switch
            checked={prefs.notifications}
            disabled={!loaded}
            label={t('settings.general.notifications')}
            onChange={(notifications) => void set({ notifications })}
          />
        </SettingsRow>
        <SettingsRow
          label={t('settings.general.notifyRoutines')}
          hint={t('settings.general.notifyRoutinesHint')}
        >
          <div className="w-[210px]">
            <Select
              label={t('settings.general.notifyRoutines')}
              value={prefs.notifyRoutines}
              disabled={!loaded || !prefs.notifications}
              options={(['always', 'attention'] as const).map((value) => ({
                value,
                label: t(`settings.general.notifyRoutinesOptions.${value}`),
                description: t(`settings.general.notifyRoutinesOptions.${value}Hint`),
              }))}
              size="sm"
              tone="surface-2"
              onChange={(notifyRoutines) => void set({ notifyRoutines })}
            />
          </div>
        </SettingsRow>
        <AttachmentLimitRow />
        <IdleWatchRows />
      </SettingsCard>

      <ComputerCard />

      <SettingsCard title={t('settings.general.data')}>
        <SettingsRow
          label={t('settings.general.folder')}
          hint={<span className="selectable break-all">{shortPath(workspace.dir)}</span>}
        >
          <Button
            size="sm"
            onClick={() => void window.milibot.revealPath(workspace.dir).catch(() => showToast('error'))}
          >
            <FolderOpen size={13} />
            {t('settings.general.reveal')}
          </Button>
        </SettingsRow>
        <BackupRows workspace={workspace} />
      </SettingsCard>

      <SettingsCard tone="danger">
        <SettingsRow label={t('settings.general.delete')} hint={t('settings.general.deleteHint')}>
          <Button size="sm" variant="danger-outline" onClick={() => setDeleting(true)}>
            <Trash2 size={13} />
            {t('settings.general.deleteButton')}
          </Button>
        </SettingsRow>
      </SettingsCard>

      {deleting && <DeleteWorkspaceDialog workspace={workspace} onClose={() => setDeleting(false)} />}
    </SettingsPage>
  )
}
