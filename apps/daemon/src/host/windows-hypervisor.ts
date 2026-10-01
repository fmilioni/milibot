import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { WindowsHypervisorState } from '@milibot/shared'

export interface HypervisorFacts {
  /** `Win32_ComputerSystem.HypervisorPresent`; null when it could not be read. */
  hypervisorPresent: boolean | null
  /**
   * `Win32_Processor.VirtualizationFirmwareEnabled` (VT-x/AMD-V on in the BIOS/UEFI); only meaningful
   * while no hypervisor runs. Null when it could not be read.
   */
  virtualizationFirmwareEnabled: boolean | null
}

export interface WindowsHypervisorDeps {
  /** `%SystemRoot%` (e.g. `C:\Windows`). */
  systemRoot: string
  exists: (path: string) => boolean
  /** Both WMI facts in one PowerShell run (null fields when unreadable). */
  facts: () => Promise<HypervisorFacts>
}

/**
 * Windows Hypervisor Platform (what WHPX needs), without admin rights. `WinHvPlatform.dll` in System32
 * tells whether the optional feature is on; WMI tells whether a hypervisor runs and, when none does,
 * whether virtualization is on in the firmware (checked first: enabling the feature needs it).
 * - `enabled`: feature on and hypervisor running;
 * - `virtualization_disabled`: no hypervisor and VT-x/AMD-V off in the firmware;
 * - `feature_disabled`: the DLL is missing;
 * - `reboot_pending`: the DLL is there, virtualization is on, but no hypervisor runs yet;
 * - `unknown`: the check failed with the DLL present (WHPX is still tried).
 */
export async function probeWindowsHypervisor(deps: WindowsHypervisorDeps): Promise<WindowsHypervisorState> {
  let dll: boolean
  try {
    dll = deps.exists(join(deps.systemRoot, 'System32', 'WinHvPlatform.dll'))
  } catch {
    return 'unknown'
  }
  let facts: HypervisorFacts
  try {
    facts = await deps.facts()
  } catch {
    facts = { hypervisorPresent: null, virtualizationFirmwareEnabled: null }
  }
  if (facts.hypervisorPresent === false && facts.virtualizationFirmwareEnabled === false) {
    return 'virtualization_disabled'
  }
  if (!dll) return 'feature_disabled'
  if (facts.hypervisorPresent === true) return 'enabled'
  if (facts.hypervisorPresent === false) return 'reboot_pending'
  return 'unknown'
}

type ExecFileFn = typeof execFile

const FACTS_COMMAND =
  '$cs = Get-CimInstance -ClassName Win32_ComputerSystem; $cpu = Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1; Write-Output "$($cs.HypervisorPresent),$($cpu.VirtualizationFirmwareEnabled)"'

function parseBool(value: string | undefined): boolean | null {
  const v = (value ?? '').trim().toLowerCase()
  return v === 'true' ? true : v === 'false' ? false : null
}

/** `%SystemRoot%` (`C:\\Windows` when the environment lacks it). */
function systemRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows'
}

/** Reads both WMI facts through PowerShell (hidden, no profile, bounded by a timeout). */
export function powershellHypervisorFacts(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 10_000,
  run: ExecFileFn = execFile,
): Promise<HypervisorFacts> {
  const powershell = join(systemRoot(env), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((resolve) => {
    run(
      existsSync(powershell) ? powershell : 'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', FACTS_COMMAND],
      { windowsHide: true, timeout: timeoutMs, encoding: 'utf8' },
      (error, stdout) => {
        const [present, firmware] = error
          ? []
          : String(stdout ?? '')
              .trim()
              .split(',')
        resolve({ hypervisorPresent: parseBool(present), virtualizationFirmwareEnabled: parseBool(firmware) })
      },
    )
  })
}

function defaultWindowsHypervisorDeps(env: NodeJS.ProcessEnv = process.env): WindowsHypervisorDeps {
  return {
    systemRoot: systemRoot(env),
    exists: existsSync,
    facts: () => powershellHypervisorFacts(env),
  }
}

/**
 * Probe for `GET /host`: one PowerShell run at a time, its result reused only for `ttlMs` to absorb bursts of
 * requests, so checking again after a change always sees the current state.
 */
export class WindowsHypervisorProbe {
  private value: { state: WindowsHypervisorState; at: number } | null = null
  private pending: Promise<WindowsHypervisorState> | null = null

  constructor(
    private readonly deps: WindowsHypervisorDeps = defaultWindowsHypervisorDeps(),
    private readonly ttlMs = 2_000,
    private readonly now: () => number = Date.now,
  ) {}

  get(): Promise<WindowsHypervisorState> {
    if (this.value && this.now() - this.value.at < this.ttlMs) return Promise.resolve(this.value.state)
    this.pending ??= probeWindowsHypervisor(this.deps)
      .then((state) => {
        this.value = { state, at: this.now() }
        return state
      })
      .finally(() => {
        this.pending = null
      })
    return this.pending
  }

  /** The last result, however old (null before the first check). */
  lastKnown(): WindowsHypervisorState | null {
    return this.value?.state ?? null
  }
}
