import { CLI_ENGINES, DEFAULT_VM_CONFIG, firstBot, type Provider, type VmSize } from '@milibot/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'

import { refreshProviders, useProviders } from '@/features/providers/api'
import { useSettingsStore } from '@/features/settings/store'
import {
  initialProviderStep,
  type ProviderStepIssue,
  providerStepIssues,
  type ProviderStepState,
  setupVmProgress,
} from '@/features/setup/lib/setup'
import {
  initialVmSize,
  loginEngines,
  planProviderSave,
  vmStepAdvance,
  vmStepNeedsBuild,
  vmStepNeedsStart,
} from '@/features/setup/lib/setup-flow'
import { useAppStore, useCurrentWorkspace } from '@/features/workspace/store'
import { useNow } from '@/hooks/use-now'
import { errorMessage } from '@/lib/errors'

import { saveProviders } from './api'
import type { StepPatch } from './ProvidersStep'
import { useSetupStore } from './store'

/** How long step 2 waits for the VM config (it carries a size copied from another workspace). */
const VM_CONFIG_WAIT_MS = 1500

/** Runs `action` once while `due` holds (again only after `due` went false). */
function useOnce(due: boolean, action: () => Promise<unknown>): void {
  const done = useRef(false)
  const run = useEffectEvent(() => void action().catch(() => undefined))
  useEffect(() => {
    if (!due || done.current) return
    done.current = true
    run()
  }, [due])
}

/**
 * The setup screens' workflow: step 1's providers (saved on "Create machine"), step 2's machine (size,
 * creation, and the kicks that resume a VM or an image build a restart left halfway), step 3's logins.
 * The decisions are the pure functions of `lib/setup-flow.ts`; `SetupScreen` only renders. The screen is
 * keyed by workspace, so switching workspaces starts the flow over.
 */
export function useSetupFlow() {
  const client = useQueryClient()
  const workspace = useCurrentWorkspace()
  const vm = useAppStore((s) => s.vm)
  const bots = useAppStore((s) => s.bots)
  const updateSetup = useAppStore((s) => s.updateSetup)
  const setupVm = useAppStore((s) => s.setupVm)
  const startVm = useAppStore((s) => s.startVm)
  const refreshVm = useAppStore((s) => s.refreshVm)
  const host = useSettingsStore((s) => s.host)
  const loadHost = useSettingsStore((s) => s.loadHost)
  const loadPreferences = useSettingsStore((s) => s.loadPreferences)
  const updatePreferences = useSettingsStore((s) => s.updatePreferences)
  const golden = useSetupStore((s) => s.golden)
  const loadGolden = useSetupStore((s) => s.loadGolden)
  const buildGolden = useSetupStore((s) => s.buildGolden)
  const workspaceId = workspace?.id ?? ''
  const step = workspace?.setup ?? 'providers'
  const providers = useProviders(workspaceId || null).data

  const [providerState, setProviderState] = useState<ProviderStepState | null>(null)
  const [chosenSize, setSize] = useState<VmSize | null>(null)
  const [legacyOffice, setLegacyOffice] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [loginIndex, setLoginIndex] = useState(0)
  const [vmWaitOver, setVmWaitOver] = useState(false)

  const reloadProviders = useCallback(() => refreshProviders(client, workspaceId), [client, workspaceId])

  useEffect(() => {
    if (!workspaceId) return
    let current = true
    void reloadProviders().then(
      (list) => current && setProviderState(initialProviderStep(list)),
      () => current && setProviderState(initialProviderStep([])),
    )
    void loadGolden().catch(() => undefined)
    void loadHost().catch(() => undefined)
    // Copied from another workspace along with the VM size.
    void loadPreferences(workspaceId)
      .then(() => current && setLegacyOffice(useSettingsStore.getState().preferences?.legacyOffice === true))
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [workspaceId, reloadProviders, loadGolden, loadHost, loadPreferences])

  useEffect(() => {
    const timer = setTimeout(() => setVmWaitOver(true), VM_CONFIG_WAIT_MS)
    return () => clearTimeout(timer)
  }, [])

  const size = chosenSize ?? initialVmSize(host, vm, vmWaitOver)

  const patchProviders = useCallback((patch: StepPatch) => {
    setProviderState((prev) =>
      prev ? { ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) } : prev,
    )
  }, [])

  // The bar between VM phases counts the boot from when it started.
  const now = useNow(1000, step === 'vm')
  const starting = vm?.state === 'starting'
  const [startingSince, setStartingSince] = useState<number | null>(null)
  if (starting && startingSince === null) setStartingSince(now)
  if (!starting && startingSince !== null) setStartingSince(null)
  const progress = setupVmProgress({
    golden,
    vm,
    bootingForSeconds: startingSince !== null ? Math.max(0, now - startingSince) / 1000 : 0,
  })

  const vmStep = { step, vm, golden, providers: providers ?? null }
  const advance = vmStepAdvance(vmStep)
  const advancing = useRef(false)
  useEffect(() => {
    if (!advance || advancing.current) return
    advancing.current = true
    void updateSetup(advance).finally(() => {
      advancing.current = false
    })
  }, [advance, updateSetup])
  useOnce(vmStepNeedsStart(vmStep), startVm)
  useOnce(vmStepNeedsBuild(vmStep), buildGolden)

  const engines = loginEngines(providers ?? null)
  const loginEngine = engines[Math.min(loginIndex, engines.length - 1)] ?? CLI_ENGINES[0]
  const issues: ProviderStepIssue[] = providerState ? providerStepIssues(providerState) : ['none_selected']
  // Back from a login to change the providers: the machine already exists.
  const machineReady = vm?.state === 'running'

  const createMachine = async () => {
    if (!providerState || !size || issues.length > 0) return
    setBusy(true)
    setError(null)
    try {
      await saveProviders(workspaceId, planProviderSave(providerState, providers ?? []))
      await reloadProviders()
      await updatePreferences(workspaceId, { legacyOffice })
      if (machineReady) {
        await updateSetup('vm')
        return
      }
      await setupVm(size)
      await refreshVm()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  /** The status line keeps showing a failure, so these only flag the retry. */
  const whileRetrying = async (action: () => Promise<unknown>) => {
    setRetrying(true)
    try {
      await action()
    } catch {
      // Shown by the progress.
    } finally {
      setRetrying(false)
    }
  }
  const retry = () => whileRetrying(() => (progress.failed === 'golden' ? buildGolden() : startVm()))
  // The newer system could not be prepared: create the VM on the image already here.
  const takeCurrentSystem = () => whileRetrying(startVm)

  const loginDone = async () => {
    if (loginIndex < engines.length - 1) setLoginIndex(loginIndex + 1)
    else await updateSetup('done')
  }

  const recheckHost = () => loadHost(true).catch(() => undefined)
  const checkQemu = async () => {
    await recheckHost()
    return useSettingsStore.getState().host?.qemu.found ?? false
  }

  return {
    workspace,
    workspaceId,
    step,
    vm,
    vmConfig: vm?.config ?? size ?? DEFAULT_VM_CONFIG,
    golden,
    host,
    providers: providers ?? ([] as Provider[]),
    providerState,
    patchProviders,
    reloadProviders,
    issues,
    size,
    setSize,
    legacyOffice,
    setLegacyOffice,
    machineReady,
    createMachine,
    busy,
    error,
    progress,
    retry,
    takeCurrentSystem,
    retrying,
    recheckHost,
    checkQemu,
    loginEngine,
    loginProvider: (providers ?? []).find((p) => p.type === loginEngine) ?? null,
    firstBot: firstBot(Object.values(bots)),
    loginDone,
    changeProviders: () => updateSetup('providers'),
  }
}
