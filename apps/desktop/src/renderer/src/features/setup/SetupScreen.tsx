import { ArrowLeft, ArrowRight, Check } from 'lucide-react'
import { type ReactNode, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { createMachineMinutes, PROVIDER_ROWS, providerRowName, rowOf } from '@/features/setup/lib/setup'
import { useAppStore } from '@/features/workspace/store'
import { cliTextParams } from '@/lib/cli-engines'
import { cn } from '@/lib/cn'
import { Button } from '@/ui/Button'
import { Spinner } from '@/ui/Spinner'

import { CliLoginStep } from './CliLoginStep'
import { ComputerStep } from './ComputerStep'
import { CreateMachineButton, MachineProgress } from './MachineStep'
import { ProvidersStep } from './ProvidersStep'
import { KvmNotice, QemuMissing, WhpxNotice } from './QemuStep'
import { SetupHero } from './SetupHero'
import { useSetupFlow } from './use-setup-flow'

type StepState = 'done' | 'active' | 'pending'

function Step({
  number,
  state,
  title,
  children,
}: {
  number: number
  state: StepState
  title: string
  children?: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <section className="flex gap-3.5" aria-current={state === 'active' ? 'step' : undefined}>
      <span
        className={cn(
          'flex size-[26px] shrink-0 items-center justify-center rounded-full text-sm font-semibold',
          state === 'done'
            ? 'bg-success text-white'
            : state === 'active'
              ? 'bg-accent text-on-accent'
              : 'bg-surface-3 text-fg-muted',
        )}
        aria-label={state === 'done' ? t('setup.stepDone', { number }) : t('setup.stepLabel', { number })}
      >
        {state === 'done' ? <Check size={14} strokeWidth={3} /> : number}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-[3px]">
        <h3
          className={cn('text-lg leading-5 font-semibold', state === 'pending' ? 'text-fg-muted' : 'text-fg')}
        >
          {title}
        </h3>
        {children}
      </div>
    </section>
  )
}

export function SetupScreen() {
  const workspaceId = useAppStore((s) => s.workspaceId)
  return <SetupFlow key={workspaceId} />
}

function SetupFlow() {
  const { t, i18n } = useTranslation()
  const flow = useSetupFlow()
  const switchWorkspace = useAppStore((s) => s.switchWorkspace)
  // A workspace created from another one can go back to it while its setup waits.
  const previous = useAppStore((s) =>
    [...s.workspaces]
      .filter((w) => w.id !== s.workspaceId && w.setup === 'done')
      .sort((a, b) => (b.lastOpenedAt ?? b.createdAt) - (a.lastOpenedAt ?? a.createdAt))
      .at(0),
  )
  const {
    workspace,
    workspaceId,
    step,
    vm,
    vmConfig,
    golden,
    host,
    providers,
    providerState,
    issues,
    size,
    busy,
    error,
    progress,
    loginEngine,
  } = flow

  const names = useMemo(() => {
    const rows = PROVIDER_ROWS.filter((row) => providers.some((p) => rowOf(p) === row))
    return new Intl.ListFormat(i18n.language, { type: 'conjunction' }).format(
      rows.map((r) => providerRowName(t, r)),
    )
  }, [providers, i18n.language, t])

  if (!workspace) return null

  const qemuMissing = host !== null && !host.qemu.found
  const hostSetup = host?.setup ?? null
  const { computer, machineReady } = flow
  const machineTitle = t('setup.machine.ready', {
    cpus: vmConfig.cpus,
    mem: vmConfig.memGb,
    disk: vmConfig.dataGb,
  })
  const computerDone = computer === 'none' || (size !== null && !qemuMissing)
  // "Create machine" when a VM must still be made; "Continue" without a computer or with it already running.
  const creates = computer === 'vm' && !machineReady

  return (
    <div className="flex h-full w-full">
      <SetupHero />
      <main className="relative flex h-full min-w-0 flex-1 flex-col bg-bg">
        {/* In the flow (not over the page): the scrolling content never slides under the back link. */}
        <div className="drag-region flex h-12 shrink-0 items-center justify-end px-4 win:pr-caption-4">
          {previous && (
            <button
              type="button"
              onClick={() => void switchWorkspace(previous.id)}
              className="no-drag focus-ring flex max-w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm text-fg-secondary hover:bg-surface-3 hover:text-fg"
            >
              <ArrowLeft size={13} className="shrink-0" />
              <span className="truncate">{t('setup.back', { name: previous.name })}</span>
            </button>
          )}
        </div>
        <div className="scroll-slim flex min-h-0 flex-1 flex-col overflow-y-auto px-10 pt-6 pb-[72px]">
          <div className="mx-auto my-auto flex w-full max-w-[560px] flex-col gap-[22px]">
            <h2 className="text-6xl leading-[30px] font-bold tracking-[-0.01em] text-fg">
              {t('setup.title')}
            </h2>

            {step === 'providers' ? (
              <>
                <Step
                  number={1}
                  state={computerDone ? 'done' : 'active'}
                  title={machineReady ? machineTitle : t('setup.computer.title')}
                >
                  {!machineReady && (
                    <ComputerStep
                      computer={computer}
                      suggestion={flow.suggestion}
                      host={host}
                      size={size}
                      legacyOffice={flow.legacyOffice}
                      onComputer={flow.setComputer}
                      onSize={flow.setSize}
                      onLegacyOffice={flow.setLegacyOffice}
                      onCheckQemu={flow.checkQemu}
                      onRecheckHost={flow.recheckHost}
                    />
                  )}
                </Step>
                <Step
                  number={2}
                  state={issues.length === 0 ? 'done' : 'active'}
                  title={t('setup.providers.title')}
                >
                  {providerState && (
                    <ProvidersStep
                      workspaceId={workspaceId}
                      state={providerState}
                      visibleRows={flow.rows}
                      providers={providers}
                      onChange={flow.patchProviders}
                      onProvidersChanged={flow.reloadProviders}
                    />
                  )}
                  <p
                    className={cn(
                      'text-xs',
                      issues.length > 0 && providerState ? 'text-fg-secondary' : 'text-fg-muted',
                    )}
                  >
                    {issues[0] && providerState
                      ? t(`setup.providers.issues.${issues[0]}`)
                      : t('setup.providers.hint')}
                  </p>
                </Step>
                <div className="flex flex-col gap-2 pl-10">
                  {creates ? (
                    <CreateMachineButton
                      minutes={createMachineMinutes(golden)}
                      busy={busy}
                      disabled={!flow.canFinish || qemuMissing}
                      onClick={() => void flow.finish()}
                    />
                  ) : (
                    <Button
                      variant="primary"
                      className="w-fit"
                      disabled={!flow.canFinish || busy}
                      onClick={() => void flow.finish()}
                    >
                      {busy ? <Spinner size={13} /> : null}
                      {t('setup.machine.continue')}
                      {!busy && <ArrowRight size={12} />}
                    </Button>
                  )}
                  {error && (
                    <p className="selectable text-xs text-danger">
                      {creates ? t('setup.machine.failed', { error }) : error}
                    </p>
                  )}
                </div>
                <Step number={3} state="pending" title={t('setup.firstBot.title')}>
                  <p className="text-sm text-fg-muted">
                    {computer === 'vm' ? t('setup.firstBot.hintPending') : t('setup.firstBot.hintNoComputer')}
                  </p>
                </Step>
              </>
            ) : (
              <>
                <Step
                  number={1}
                  state="done"
                  title={computer === 'vm' ? machineTitle : t('setup.computer.none.name')}
                />
                <Step number={2} state="done" title={t('setup.providers.summary', { names })} />
                {step === 'vm' && computer === 'vm' && (
                  <Step number={3} state="active" title={t('setup.machine.title')}>
                    <p className="text-sm text-fg-secondary">
                      {t('setup.machine.summary', {
                        cpus: vmConfig.cpus,
                        mem: vmConfig.memGb,
                        disk: vmConfig.dataGb,
                      })}
                    </p>
                    {qemuMissing && <QemuMissing onCheck={flow.checkQemu} />}
                    <KvmNotice setup={hostSetup} onCheck={flow.recheckHost} />
                    <WhpxNotice host={host} onCheck={flow.recheckHost} />
                    <MachineProgress
                      progress={progress}
                      golden={golden}
                      vmError={vm?.error ?? null}
                      onRetry={() => void flow.retry()}
                      onUseCurrent={() => void flow.takeCurrentSystem()}
                      retrying={flow.retrying}
                    />
                  </Step>
                )}
                {step === 'login' && (
                  <Step number={3} state="active" title={t('setup.login.title', cliTextParams(loginEngine))}>
                    <p className="text-sm leading-[1.5] text-fg-secondary">
                      {t('setup.login.description', cliTextParams(loginEngine))}
                    </p>
                    <CliLoginStep
                      key={loginEngine}
                      engine={loginEngine}
                      workspaceId={workspaceId}
                      workspaceName={workspace.name}
                      firstBot={flow.firstBot}
                      vm={vm}
                      providerId={flow.loginProvider?.id ?? null}
                      onDone={flow.loginDone}
                      onChangeProviders={flow.changeProviders}
                    />
                  </Step>
                )}
                {step === 'vm' && computer !== 'vm' && (
                  <Step number={3} state="pending" title={t('setup.firstBot.title')}>
                    <p className="text-sm text-fg-muted">{t('setup.firstBot.hint')}</p>
                  </Step>
                )}
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
