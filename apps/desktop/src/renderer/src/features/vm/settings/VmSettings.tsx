import type { VmDetails, VmDiskKind } from '@milibot/shared'
import { useQueryClient } from '@tanstack/react-query'
import { Camera, History, RotateCw, TriangleAlert } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/api/queries'
import { useApiQuery } from '@/api/use-api-query'
import { TcgNotice } from '@/features/settings/HostWarnings'
import { Notice, SettingsCard, SettingsPage, SettingsRow, Stepper } from '@/features/settings/SettingsLayout'
import { useSettingsStore, useWorkspacePreferences } from '@/features/settings/store'
import { useSetupStore } from '@/features/setup/store'
import { vmSettings } from '@/features/vm/api'
import { availableSystemRevision, systemUpdatePhase, vmTaskBusy } from '@/features/vm/lib/system-update'
import { useVmStats } from '@/features/vm/use-vm-stats'
import { VmUsageCard } from '@/features/vm/VmUsageCard'
import { useApiMutation } from '@/features/workspace/use-api-mutation'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { AsyncView } from '@/ui/AsyncView'
import { Button } from '@/ui/Button'
import { Spinner } from '@/ui/Spinner'
import { Switch } from '@/ui/Switch'

import { CreateSnapshotDialog, SnapshotsDialog } from './SnapshotDialogs'
import { SystemUpdateNotice, SystemUpdateProgress } from './SystemUpdate'
import { DiskCard, ResourceCard, StateBadge } from './VmCards'
import { GrowDiskDialog, ResetVmDialog, UpdateSystemDialog } from './VmDialogs'

const GiB = 1024 ** 3

type Dialog =
  | { type: 'grow'; disk: VmDiskKind }
  | { type: 'createSnapshot' }
  | { type: 'snapshots' }
  | { type: 'reset' }
  | { type: 'updateSystem' }

export function VmSettings() {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const host = useSettingsStore((s) => s.host)
  const loadHost = useSettingsStore((s) => s.loadHost)
  const { prefs, loaded, set: setPrefs } = useWorkspacePreferences(workspaceId)
  const key = queryKeys.vmDetails(workspaceId)
  const query = useApiQuery(key, () => vmSettings.details(workspaceId))
  const details = query.data
  const queryClient = useQueryClient()
  // What an action returns is the VM as it is now, until the details are read again.
  const action = useApiMutation((call: () => Promise<VmDetails>) => call(), {
    onSuccess: (result) => queryClient.setQueryData(key, result),
  })
  const stats = useVmStats(workspaceId, details?.vm.state === 'running')
  const [dialog, setDialog] = useState<Dialog | null>(null)

  useEffect(() => {
    void loadHost().catch(() => undefined)
  }, [loadHost])

  const run = async (call: () => Promise<VmDetails>) => {
    setDialog(null)
    if (!(await action.run(call))) query.reload()
  }

  if (!details) {
    return (
      <SettingsPage title={t('settings.sections.vm')} subtitle={t('settings.vm.subtitle')}>
        <AsyncView data={details} error={query.error} onRetry={query.reload}>
          {() => null}
        </AsyncView>
      </SettingsPage>
    )
  }

  const config = details.vm.config
  const running = details.vm.state === 'running'
  const task = details.task
  const busy = vmTaskBusy(task)
  const updating = systemUpdatePhase(details)
  const updateRunning = updating === 'running'
  const changedCpus = details.running !== null && details.running.cpus !== config.cpus
  const changedMem = details.running !== null && details.running.memGb !== config.memGb

  let pending: ReactNode = null
  if (details.pendingRestart && details.running) {
    pending =
      changedMem && !changedCpus
        ? t('settings.vm.pendingMemory', { from: details.running.memGb, to: config.memGb })
        : changedCpus && !changedMem
          ? t('settings.vm.pendingCpus', { from: details.running.cpus, to: config.cpus })
          : t('settings.vm.pendingBoth')
  }

  return (
    <SettingsPage
      title={t('settings.sections.vm')}
      subtitle={t('settings.vm.subtitle')}
      actions={<StateBadge details={details} />}
    >
      <TcgNotice />
      {updating && (
        <SystemUpdateProgress
          status={updating}
          onCancel={() => void run(() => vmSettings.cancelSystemUpdate(workspaceId))}
        />
      )}
      {!updating && availableSystemRevision(details.vm) !== null && (
        <SystemUpdateNotice details={details} onUpdate={() => setDialog({ type: 'updateSystem' })} />
      )}
      {task && task.status !== 'done' && !updateRunning && (
        <Notice
          tone={task.status === 'error' ? 'danger' : 'neutral'}
          icon={
            task.status === 'error' ? (
              <TriangleAlert size={14} className="text-danger" />
            ) : (
              <Spinner size={14} />
            )
          }
        >
          {task.status === 'error'
            ? t('settings.vm.taskError', { error: task.error ?? '' })
            : task.status === 'waiting_idle'
              ? t('settings.vm.waitingIdle')
              : t(`settings.vm.tasks.${task.kind}`)}
        </Notice>
      )}
      {pending && !busy && (
        <Notice
          tone="warning"
          icon={<RotateCw size={14} className="text-warning" />}
          action={
            <Button
              size="sm"
              className="bg-warning text-white hover:brightness-105"
              onClick={() => void run(() => vmSettings.restart(workspaceId, true))}
            >
              {t('settings.vm.restartWhenIdle')}
            </Button>
          }
        >
          {pending}
        </Notice>
      )}

      {running && <VmUsageCard stats={stats} onGrow={(disk) => setDialog({ type: 'grow', disk })} />}
      {running && <h2 className="pt-2 text-base font-semibold text-fg">{t('settings.vm.sizeTitle')}</h2>}

      <div className="grid grid-cols-2 gap-3.5">
        <ResourceCard
          title={t('settings.vm.cpus')}
          value={config.cpus}
          min={1}
          max={host?.maxVmCpus ?? config.cpus}
          changed={changedCpus}
          hint={host ? t('settings.vm.cpusHint', { cores: host.cpus, max: host.maxVmCpus }) : ''}
          onCommit={(cpus) => void run(() => vmSettings.updateResources(workspaceId, { cpus }))}
        />
        <ResourceCard
          title={t('settings.vm.memory')}
          value={config.memGb}
          unit={t('common.gbUnit')}
          min={2}
          max={host?.maxVmMemoryGb ?? config.memGb}
          changed={changedMem}
          hint={host ? t('settings.vm.memoryHint', { total: host.memoryGb, max: host.maxVmMemoryGb }) : ''}
          onCommit={(memGb) => void run(() => vmSettings.updateResources(workspaceId, { memGb }))}
        />
        <DiskCard
          disk="system"
          usage={details.disks.system}
          inGuest={stats?.disks.system ?? null}
          onGrow={() => setDialog({ type: 'grow', disk: 'system' })}
        />
        <DiskCard
          disk="data"
          usage={details.disks.data}
          inGuest={stats?.disks.data ?? null}
          onGrow={() => setDialog({ type: 'grow', disk: 'data' })}
        />
      </div>

      <SettingsCard>
        <SettingsRow label={t('settings.vm.parallel')} hint={t('settings.vm.parallelHint')}>
          <Stepper
            value={prefs.maxParallelBots}
            min={1}
            max={10}
            label={t('settings.vm.parallel')}
            decrementLabel={t('settings.vm.less')}
            incrementLabel={t('settings.vm.more')}
            onChange={(maxParallelBots) => void setPrefs({ maxParallelBots })}
          />
        </SettingsRow>
        <SettingsRow label={t('settings.vm.perBot')} hint={t('settings.vm.perBotHint')}>
          <Switch
            checked={prefs.perBotLimits}
            disabled={!loaded}
            label={t('settings.vm.perBot')}
            onChange={(perBotLimits) => void setPrefs({ perBotLimits })}
          />
        </SettingsRow>
        {prefs.perBotLimits && (
          <>
            <SettingsRow
              label={t('settings.vm.perBotCpu')}
              hint={t('settings.vm.perBotCpuHint', { cpus: config.cpus })}
            >
              <Stepper
                value={Math.min(prefs.perBotCpuPercent, config.cpus * 100)}
                min={25}
                max={config.cpus * 100}
                step={25}
                format={(value) => `${value}%`}
                label={t('settings.vm.perBotCpu')}
                decrementLabel={t('settings.vm.less')}
                incrementLabel={t('settings.vm.more')}
                onChange={(perBotCpuPercent) => void setPrefs({ perBotCpuPercent })}
              />
            </SettingsRow>
            <SettingsRow
              label={t('settings.vm.perBotMemory')}
              hint={t('settings.vm.perBotMemoryHint', { memGb: config.memGb })}
            >
              <Stepper
                value={Math.min(prefs.perBotMemoryGb, config.memGb)}
                min={1}
                max={config.memGb}
                format={(value) => t('common.gb', { value })}
                label={t('settings.vm.perBotMemory')}
                decrementLabel={t('settings.vm.less')}
                incrementLabel={t('settings.vm.more')}
                onChange={(perBotMemoryGb) => void setPrefs({ perBotMemoryGb })}
              />
            </SettingsRow>
          </>
        )}
        <SettingsRow label={t('settings.vm.resolution')} hint={t('settings.vm.resolutionHint')}>
          <span className="font-mono text-sm text-fg-secondary">1280 × 800</span>
        </SettingsRow>
      </SettingsCard>

      <div className="flex flex-wrap gap-2.5">
        <Button
          variant="outline"
          disabled={busy || !details.disks.system}
          onClick={() => setDialog({ type: 'createSnapshot' })}
        >
          <Camera size={13} />
          {t('settings.vm.createSnapshot')}
        </Button>
        <Button
          variant="outline"
          disabled={busy || !details.disks.system}
          onClick={() => setDialog({ type: 'snapshots' })}
        >
          <History size={13} />
          {t('settings.vm.restoreEllipsis')}
          {details.snapshots.length > 0 && (
            <span className="text-fg-muted">({details.snapshots.length})</span>
          )}
        </Button>
        <Button
          variant="danger-outline"
          disabled={busy || !details.disks.system}
          onClick={() => setDialog({ type: 'reset' })}
        >
          <RotateCw size={13} />
          {t('settings.vm.reset.button')}
        </Button>
      </div>

      {dialog?.type === 'grow' && (
        <GrowDiskDialog
          disk={dialog.disk}
          currentGb={Math.round((details.disks[dialog.disk]?.virtualBytes ?? 0) / GiB)}
          running={running}
          onClose={() => setDialog(null)}
          onConfirm={(sizeGb) => void run(() => vmSettings.growDisk(workspaceId, dialog.disk, sizeGb))}
        />
      )}
      {dialog?.type === 'createSnapshot' && (
        <CreateSnapshotDialog
          running={running}
          onClose={() => setDialog(null)}
          onConfirm={(name) => void run(() => vmSettings.createSnapshot(workspaceId, name || null))}
        />
      )}
      {dialog?.type === 'snapshots' && (
        <SnapshotsDialog
          details={details}
          onClose={() => setDialog(null)}
          onRestore={(name) => void run(() => vmSettings.restoreSnapshot(workspaceId, name))}
          onDelete={(name) => void run(() => vmSettings.deleteSnapshot(workspaceId, name))}
        />
      )}
      {dialog?.type === 'updateSystem' && (
        <UpdateSystemDialog
          details={details}
          onClose={() => setDialog(null)}
          onConfirm={(whenIdle) =>
            void run(async () => {
              // Starts (or rebuilds) the new golden image; the update waits for it either way.
              await useSetupStore
                .getState()
                .buildGolden()
                .catch((err: unknown) => console.error('[settings] golden build failed to start', err))
              return vmSettings.updateSystem(workspaceId, whenIdle)
            })
          }
        />
      )}
      {dialog?.type === 'reset' && (
        <ResetVmDialog
          onClose={() => setDialog(null)}
          onConfirm={() => void run(() => vmSettings.reset(workspaceId))}
        />
      )}
    </SettingsPage>
  )
}
