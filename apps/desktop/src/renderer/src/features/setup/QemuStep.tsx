import type { HostInfo, HostSetup } from '@milibot/shared'
import { Check, Copy, Cpu, RotateCw, SquareTerminal } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { whpxCase } from '@/features/setup/lib/setup'
import { useCopyFlash } from '@/hooks/use-copy-flash'
import { errorMessage } from '@/lib/errors'
import { platformKind } from '@/lib/platform'
import { Button } from '@/ui/Button'
import { Spinner } from '@/ui/Spinner'

const MAC_INSTALL_COMMAND = 'brew install qemu'
const MAC_REINSTALL_COMMAND = 'brew reinstall qemu'

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
 * Shown in the machine step while QEMU is missing. macOS: Homebrew, with a button that runs it in
 * Terminal. Linux: the command for the distro's package manager to copy, then "check again".
 * Windows: the `winget` command to copy, then "check again".
 */
export function QemuMissing({
  onCheck,
  setup,
  setupFailed,
  binary,
  firmwareMissing = false,
}: {
  onCheck: () => Promise<boolean>
  setup: HostSetup | null
  /** The daemon did not report the install command (Linux and Windows). */
  setupFailed: boolean
  /** `qemu.binary` from `GET /host` (e.g. `qemu-system-x86_64`); absent until the host is known. */
  binary?: string
  /** QEMU is there but its UEFI firmware is not (`qemu.firmware.found` false). */
  firmwareMissing?: boolean
}) {
  const { t } = useTranslation()
  const [stillMissing, setStillMissing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const kind = platformKind()
  const mac = kind === 'mac'
  const command = mac
    ? firmwareMissing
      ? MAC_REINSTALL_COMMAND
      : MAC_INSTALL_COMMAND
    : (setup?.installCommand ?? null)
  const qemu = binary ? `QEMU (${binary})` : 'QEMU'
  const description = firmwareMissing
    ? t(
        mac
          ? 'setup.machine.qemu.firmwareMissing'
          : kind === 'windows'
            ? 'setup.machine.qemu.firmwareMissingWindows'
            : 'setup.machine.qemu.firmwareMissingLinux',
      )
    : mac
      ? t('setup.machine.qemu.description')
      : kind === 'windows'
        ? t('setup.machine.qemu.descriptionWindows', { qemu })
        : command
          ? t('setup.machine.qemu.descriptionLinux', { qemu })
          : t('setup.machine.qemu.descriptionNoManager', { qemu })

  const openTerminal = () => {
    setError(null)
    window.milibot.openQemuInstaller().catch((err: unknown) => setError(errorMessage(err)))
  }

  const check = async () => {
    setStillMissing(false)
    setStillMissing(!(await onCheck()))
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border border-border bg-surface-2 px-3 py-3">
      <div className="flex items-center gap-2 text-base font-semibold text-fg">
        <SquareTerminal size={14} className="text-accent" aria-hidden />
        {t('setup.machine.qemu.title')}
      </div>
      {!mac && !setup ? (
        setupFailed ? (
          <p className="text-sm leading-[1.5] text-fg-secondary" role="alert">
            {t('setup.machine.qemu.setupFailed', { qemu })}
          </p>
        ) : (
          <Spinner size={14} label={t('common.loading')} className="text-fg-muted" />
        )
      ) : (
        <>
          <p className="text-sm leading-[1.5] text-fg-secondary">{description}</p>
          {command && <CommandLine command={command} />}
        </>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {mac && !firmwareMissing && (
          <Button variant="primary" size="sm" onClick={openTerminal}>
            <SquareTerminal size={12} />
            {t('setup.machine.qemu.openTerminal')}
          </Button>
        )}
        <CheckButton onCheck={check} variant={mac && !firmwareMissing ? 'secondary' : 'primary'} />
        {mac && (
          <button
            type="button"
            onClick={() => void window.milibot.openExternal('https://brew.sh')}
            className="focus-ring rounded text-xs text-fg-muted underline-offset-2 hover:text-fg-secondary hover:underline"
          >
            {t('setup.machine.qemu.noBrew')}
          </button>
        )}
      </div>
      {stillMissing && (
        <p className="text-xs text-fg-secondary" role="status">
          {mac ? t('setup.machine.qemu.stillMissing') : t('setup.machine.qemu.stillMissingLinux', { qemu })}
        </p>
      )}
      {error && (
        <p className="selectable text-xs text-danger">{t('setup.machine.qemu.openFailed', { error })}</p>
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
