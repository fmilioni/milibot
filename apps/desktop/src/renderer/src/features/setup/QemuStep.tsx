import type { HostInfo, HostSetup } from '@milibot/shared'
import { Check, Copy, Cpu, RotateCw, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { whpxCase } from '@/features/setup/lib/setup'
import { useCopyFlash } from '@/hooks/use-copy-flash'
import { Button } from '@/ui/Button'
import { Spinner } from '@/ui/Spinner'

function CommandLine({ command }: { command: string }) {
  const { t } = useTranslation()
  const [copied, copy] = useCopyFlash()
  return (
    <div className="flex items-center gap-2 rounded-[7px] border border-border bg-surface px-2.5 py-1.5">
      <code className="selectable min-w-0 flex-1 font-mono text-sm break-all text-fg">{command}</code>
      <button
        type="button"
        onClick={() => copy(command)}
        aria-label={t('setup.machine.qemu.copy')}
        title={copied ? t('setup.machine.qemu.copied') : t('setup.machine.qemu.copy')}
        className="focus-ring flex size-6 shrink-0 items-center justify-center rounded text-fg-secondary hover:bg-surface-3"
      >
        {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
      </button>
    </div>
  )
}

/** "Check again" that spins while `onCheck` runs. */
function CheckButton({
  onCheck,
  variant = 'secondary',
}: {
  onCheck: () => Promise<unknown>
  variant?: 'primary' | 'secondary'
}) {
  const { t } = useTranslation()
  const [checking, setChecking] = useState(false)
  const check = async () => {
    setChecking(true)
    try {
      await onCheck()
    } finally {
      setChecking(false)
    }
  }
  return (
    <Button size="sm" variant={variant} onClick={() => void check()} disabled={checking}>
      {checking ? <Spinner size={12} /> : <RotateCw size={12} />}
      {t('setup.machine.qemu.check')}
    </Button>
  )
}

/**
 * Shown in the machine step when the QEMU that ships with Milibot is not there (a damaged install): the app
 * has to be reinstalled.
 */
export function QemuMissing({ onCheck }: { onCheck: () => Promise<boolean> }) {
  const { t } = useTranslation()
  const [stillMissing, setStillMissing] = useState(false)
  const check = async () => {
    setStillMissing(false)
    setStillMissing(!(await onCheck()))
  }
  return (
    <div
      className="flex flex-col gap-2.5 rounded-[10px] border border-border bg-surface-2 px-3 py-3"
      role="alert"
    >
      <div className="flex items-center gap-2 text-base font-semibold text-fg">
        <TriangleAlert size={14} className="text-danger" aria-hidden />
        {t('setup.machine.qemu.title')}
      </div>
      <p className="text-sm leading-[1.5] text-fg-secondary">{t('setup.machine.qemu.description')}</p>
      <div>
        <CheckButton onCheck={check} variant="primary" />
      </div>
      {stillMissing && (
        <p className="text-xs text-fg-secondary" role="status">
          {t('setup.machine.qemu.stillMissing')}
        </p>
      )}
    </div>
  )
}

/**
 * A host setting that keeps the VM from running at full speed: what is wrong, the command that fixes
 * it and "check again". It warns without blocking the setup (the VM still runs, emulated).
 */
function HostFixCard({
  title,
  body,
  command,
  note,
  onCheck,
}: {
  title: string
  body: string
  command?: string | null
  note?: string
  onCheck: () => Promise<unknown>
}) {
  return (
    <div
      className="flex flex-col gap-2.5 rounded-[10px] border border-border bg-warning-tint px-3 py-3"
      role="status"
    >
      <div className="flex items-center gap-2 text-base font-semibold text-fg">
        <Cpu size={14} className="text-warning" aria-hidden />
        {title}
      </div>
      <p className="text-sm leading-[1.5] text-fg-secondary">{body}</p>
      {command && <CommandLine command={command} />}
      {note && <p className="text-xs leading-[1.5] text-fg-muted">{note}</p>}
      <div>
        <CheckButton onCheck={onCheck} />
      </div>
    </div>
  )
}

const KVM_TEXT = {
  no_device: { title: 'setup.machine.kvm.noDeviceTitle', body: 'setup.machine.kvm.noDevice' },
  no_permission: { title: 'setup.machine.kvm.noPermissionTitle', body: 'setup.machine.kvm.noPermission' },
  relogin: { title: 'setup.machine.kvm.reloginTitle', body: 'setup.machine.kvm.relogin' },
} as const

/** Linux: the VM needs `/dev/kvm` (and access to it) to run at full speed. */
export function KvmNotice({ setup, onCheck }: { setup: HostSetup | null; onCheck: () => Promise<unknown> }) {
  const { t } = useTranslation()
  const kvm = setup?.kvm
  if (!kvm || kvm.status === 'ok') return null
  const text = KVM_TEXT[kvm.status]
  return <HostFixCard title={t(text.title)} body={t(text.body)} command={kvm.fixCommand} onCheck={onCheck} />
}

/** PowerShell (as administrator) that turns on the Windows Hypervisor Platform. */
const WHPX_ENABLE_COMMAND = 'Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform'

/**
 * Windows: the VM needs the Windows Hypervisor Platform (WHPX) to run at full speed. `onCheck` reads
 * `GET /host` again (the daemon checks WHPX on every call).
 */
export function WhpxNotice({ host, onCheck }: { host: HostInfo | null; onCheck: () => Promise<unknown> }) {
  const { t } = useTranslation()
  const kind = whpxCase(host)
  if (!kind) return null
  const showCommand = kind === 'feature_disabled' || kind === 'unavailable'
  return (
    <HostFixCard
      title={t(`setup.machine.whpx.${kind}.title`)}
      body={t(`setup.machine.whpx.${kind}.body`)}
      {...(showCommand
        ? {
            command: WHPX_ENABLE_COMMAND,
            note: t(
              kind === 'unavailable'
                ? 'setup.machine.whpx.unavailable.note'
                : 'setup.machine.whpx.restartNote',
            ),
          }
        : {})}
      onCheck={onCheck}
    />
  )
}
