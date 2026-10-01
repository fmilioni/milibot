/**
 * Host platform layer: data folder, PATH handling, binary names and the QEMU profile per host.
 * Pure functions with the host injected (no Node imports), so the daemon, the Electron main and
 * renderer, and the host CLIs (`vm/host` imports this file directly; Node strips the types)
 * share one source and every branch is testable on any machine.
 */

export type HostPlatform = 'darwin' | 'linux' | 'win32'
export type HostArch = 'arm64' | 'x64'
/** Debian's architecture names, used in the base image and the golden file names. */
export type GoldenArch = 'arm64' | 'amd64'

export interface Host {
  /** `process.platform` */
  platform: string
  /** `process.arch` */
  arch: string
  env: Record<string, string | undefined>
  /** `os.homedir()` */
  homedir: string
}

/** Overrides the data root (daemon, Electron and the VM scripts). */
export const DATA_DIR_ENV = 'MILIBOT_DATA_DIR'

function pathSeparator(platform: string): '/' | '\\' {
  return platform === 'win32' ? '\\' : '/'
}

export function pathDelimiter(platform: string): ':' | ';' {
  return platform === 'win32' ? ';' : ':'
}

/** Joins with the platform's separator (no normalization beyond trimming duplicate separators). */
export function joinPath(platform: string, ...parts: string[]): string {
  const sep = pathSeparator(platform)
  const trim = platform === 'win32' ? /[\\/]+$/ : /\/+$/
  const [first = '', ...rest] = parts.filter((part) => part !== '')
  const head = first.replace(trim, '')
  const tail = rest.map((part) => part.replace(/^[\\/]+/, '').replace(trim, '')).filter(Boolean)
  if (!tail.length) return head || first
  return `${head}${sep}${tail.join(sep)}`
}

export function executableName(name: string, platform: string): string {
  return platform === 'win32' && !/\.exe$/i.test(name) ? `${name}.exe` : name
}

/**
 * Default data root: macOS `~/Library/Application Support/Milibot`, Linux `$XDG_DATA_HOME/milibot`
 * (`~/.local/share/milibot`), Windows `%LOCALAPPDATA%\Milibot` (never Roaming: images and disks are
 * tens of GB).
 */
export function defaultDataRoot(host: Host): string {
  const { platform, env, homedir } = host
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || joinPath('win32', homedir, 'AppData', 'Local')
    return joinPath('win32', local, 'Milibot')
  }
  if (platform === 'darwin') return joinPath('darwin', homedir, 'Library', 'Application Support', 'Milibot')
  // XDG: a relative XDG_DATA_HOME is invalid and must be ignored.
  const xdg = env.XDG_DATA_HOME?.startsWith('/')
    ? env.XDG_DATA_HOME
    : joinPath(platform, homedir, '.local', 'share')
  return joinPath(platform, xdg, 'milibot')
}

export function resolveDataRoot(host: Host): string {
  return host.env[DATA_DIR_ENV] || defaultDataRoot(host)
}

export const DAEMON_INFO_FILE = 'daemon.json'

/** Files at the top of the data root that both the daemon and the desktop app read or write. */
export function dataLayout(root: string, platform: string) {
  const logsDir = joinPath(platform, root, 'logs')
  return {
    root,
    /** Written by the supervisor once it is listening (`DaemonInfo`). */
    daemonInfo: joinPath(platform, root, DAEMON_INFO_FILE),
    logsDir,
    /** The detached daemon's stdout and stderr (the app and the login items append to it). */
    daemonLog: joinPath(platform, logsDir, 'daemon.log'),
    rendererLog: joinPath(platform, logsDir, 'renderer.log'),
    /** Chromium's `userData` of the packaged app. */
    electronDir: joinPath(platform, root, 'electron'),
  }
}
export type DataLayout = ReturnType<typeof dataLayout>

function programFilesDir(env: Host['env']): string {
  return env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files'
}

/**
 * Where QEMU and the other host tools usually live when the PATH of a GUI app, LaunchAgent or
 * autostart entry lacks them: Homebrew on macOS, the system dirs on Linux, the QEMU installer's
 * folder on Windows (winget/official installer).
 */
function extraBinDirs(host: Pick<Host, 'platform' | 'env'>): string[] {
  switch (host.platform) {
    case 'darwin':
      return [
        '/opt/homebrew/bin',
        '/opt/homebrew/sbin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
      ]
    case 'win32':
      return [joinPath('win32', programFilesDir(host.env), 'qemu')]
    default:
      return ['/usr/local/bin', '/usr/bin', '/bin', '/usr/local/sbin', '/usr/sbin', '/sbin']
  }
}

/** PATH value of the current process (Windows spells it `Path`). */
function currentPathValue(env: Record<string, string | undefined>): string {
  return env.PATH ?? env.Path ?? ''
}

/** `prepend` + the current PATH + `extraBinDirs`, deduplicated, joined with the platform delimiter. */
export function searchPath(host: Pick<Host, 'platform' | 'env'>, prepend: string[] = []): string {
  const delimiter = pathDelimiter(host.platform)
  const current = currentPathValue(host.env).split(delimiter).filter(Boolean)
  const seen = new Set<string>()
  const out: string[] = []
  for (const dir of [...prepend, ...current, ...extraBinDirs(host)]) {
    const key = host.platform === 'win32' ? dir.toLowerCase() : dir
    if (seen.has(key)) continue
    seen.add(key)
    out.push(dir)
  }
  return out.join(delimiter)
}

/** Candidate files for a binary on the search path (the caller checks which one exists). */
export function executableCandidates(name: string, host: Pick<Host, 'platform' | 'env'>): string[] {
  const file = executableName(name, host.platform)
  return searchPath(host)
    .split(pathDelimiter(host.platform))
    .map((dir) => joinPath(host.platform, dir, file))
}

export type VmAccel = 'hvf' | 'kvm' | 'whpx' | 'tcg'

export interface FirmwarePair {
  /** Read-only UEFI code. */
  code: string
  /** Template of the writable variable store, copied per VM. */
  vars: string
}

export interface VmProfile {
  platform: HostPlatform
  arch: HostArch
  goldenArch: GoldenArch
  qemuBinary: string
  qemuImgBinary: string
  machine: string
  /** Value of `-accel` (the accelerator actually used, after the fallback). */
  accel: string
  accelKind: VmAccel
  /** The host's hardware accelerator (`hvf`, `kvm`, `whpx`), even when it fell back to TCG. */
  preferredAccel: Exclude<VmAccel, 'tcg'>
  cpu: string
  /** Firmware pairs to try, in order; the first whose files both exist wins. */
  firmware: FirmwarePair[]
  /** QMP transport: a unix socket in the VM dir, or TCP on `portBase + QMP_TCP_OFFSET` (Windows). */
  qmp: 'unix' | 'tcp'
  /** TCG (software emulation): the interface warns that the VM will be slow. */
  slow: boolean
  /** Why the hardware accelerator is not used (null when it is). */
  slowReason: string | null
}

/** Bot desktops per VM: displays 1..50, each with its VNC port forwarded at `portBase + display`. */
export const VNC_DISPLAYS = 50

/** Guest port of display N's VNC server: `VNC_PORT_BASE + N`. */
export const VNC_PORT_BASE = 5900

/** Guest loopback port of the Chrome DevTools of display N: `CDP_PORT_BASE + N`. */
export const CDP_PORT_BASE = 9222

/** Guest port of the guest agent, forwarded at the VM's port base. */
export const GUEST_AGENT_PORT = 8765

/** Offset of the QMP TCP port from the VM's port base (after the VNC ports). */
export const QMP_TCP_OFFSET = VNC_DISPLAYS + 1

/** Contents of `vm/golden-revision`: a positive integer, else 1. */
export function parseGoldenRevision(text: string): number {
  const value = Number(text.trim())
  return Number.isInteger(value) && value > 0 ? value : 1
}

export interface VmProfileProbe {
  /**
   * Whether the hardware accelerator can be used: Linux = `/dev/kvm` readable and writable. macOS
   * (HVF) and Windows (WHPX) are assumed available unless this says false.
   */
  accelAvailable?: boolean
  /** Extra firmware dir to try first (`MILIBOT_QEMU_SHARE`). */
  qemuShare?: string
  /** Directory of the QEMU binary (Windows: `…\qemu`, whose `share` has the firmware). */
  qemuDir?: string
  /** WHPX's in-hypervisor interrupt controller (Windows only; see `whpxAccelArg`). */
  whpxKernelIrqchip?: WhpxKernelIrqchip
  /** Why the accelerator is unavailable, when the probe knows better than the platform default. */
  slowReason?: string
}

/**
 * `kernel-irqchip` of `-accel whpx`: `default` leaves QEMU's choice (it picks what the Windows build
 * supports), `off` emulates the APIC in QEMU (works where the hypervisor's APIC emulation fails, slower
 * interrupts), `on` forces the hypervisor's. Overridden by `MILIBOT_WHPX_KERNEL_IRQCHIP=on|off`.
 */
export type WhpxKernelIrqchip = 'default' | 'on' | 'off'

/** `on`/`off`; anything else means "not forced". */
export const WHPX_KERNEL_IRQCHIP_ENV = 'MILIBOT_WHPX_KERNEL_IRQCHIP'

export function parseWhpxKernelIrqchip(value: unknown): 'on' | 'off' | null {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return v === 'on' || v === 'off' ? v : null
}

export function whpxAccelArg(mode: WhpxKernelIrqchip = 'default'): string {
  return mode === 'default' ? 'whpx' : `whpx,kernel-irqchip=${mode}`
}

/** QEMU's log when WHPX itself is missing (feature off, no VT-x, hypervisor not running): boot with TCG. */
export function isWhpxUnavailableLog(log: string): boolean {
  return /No accelerator found|WHPX: No accelerator|WHvGetCapability failed|failed to initialize whpx/i.test(
    log,
  )
}

/**
 * QEMU's log after WHPX failed to set up or run with the hypervisor's interrupt controller (APIC emulation
 * mode not supported, interrupt injection failed): retry with `kernel-irqchip=off`.
 */
export function isWhpxIrqchipFailureLog(log: string): boolean {
  if (isWhpxUnavailableLog(log)) return false
  return /irqchip|LocalApicEmulation|APIC emulation|injection failed|WHPX: Failed to|WHvSetupPartition|WHvSetPartitionProperty|WHvRequestInterrupt/i.test(
    log,
  )
}

/**
 * Windows Hypervisor Platform (what WHPX needs), as the daemon's probe sees it: `feature_disabled` = the
 * optional feature is off; `reboot_pending` = it is on but no hypervisor runs yet (reboot after enabling);
 * `virtualization_disabled` = VT-x/AMD-V off in the firmware; `unknown` = the check failed (WHPX is
 * still tried; QEMU falls back to TCG at boot).
 */
export type WindowsHypervisorState =
  'enabled' | 'feature_disabled' | 'reboot_pending' | 'virtualization_disabled' | 'unknown'

/**
 * `vmAccel.reason` of `GET /host` for a state that rules WHPX out (null when WHPX is tried). The desktop
 * keys its setup instructions on these exact names.
 */
export function whpxSlowReason(state: WindowsHypervisorState | null | undefined): string | null {
  switch (state) {
    case 'feature_disabled':
      return 'whpx_feature_disabled'
    case 'reboot_pending':
      return 'whpx_reboot_pending'
    case 'virtualization_disabled':
      return 'virtualization_disabled'
    default:
      return null
  }
}

/** Whether WHPX should be tried for a hypervisor state (`unknown` tries it; QEMU falls back to TCG). */
export function whpxUsable(state: WindowsHypervisorState | null | undefined): boolean {
  return whpxSlowReason(state) === null
}

function goldenArchOf(arch: string): GoldenArch {
  return arch === 'x64' ? 'amd64' : 'arm64'
}

function aarch64Share(dir: string, platform: string): FirmwarePair {
  return {
    code: joinPath(platform, dir, 'edk2-aarch64-code.fd'),
    vars: joinPath(platform, dir, 'edk2-arm-vars.fd'),
  }
}

function x86Share(dir: string, platform: string): FirmwarePair {
  return {
    code: joinPath(platform, dir, 'edk2-x86_64-code.fd'),
    vars: joinPath(platform, dir, 'edk2-i386-vars.fd'),
  }
}

/** Firmware locations per host, most specific first (distro packages, then QEMU's own `share`). */
export function firmwareCandidates(
  platform: string,
  arch: string,
  probe: VmProfileProbe = {},
  env: Host['env'] = {},
): FirmwarePair[] {
  const share = (dirs: string[], make: (dir: string, p: string) => FirmwarePair) =>
    dirs.map((d) => make(d, platform))
  const custom = probe.qemuShare ? [probe.qemuShare] : []
  if (platform === 'darwin') {
    return share([...custom, '/opt/homebrew/share/qemu', '/usr/local/share/qemu'], aarch64Share)
  }
  if (platform === 'win32') {
    const dirs = [...custom]
    if (probe.qemuDir) dirs.push(joinPath('win32', probe.qemuDir, 'share'))
    dirs.push(joinPath('win32', programFilesDir(env), 'qemu', 'share'))
    return share(dirs, x86Share)
  }
  if (arch === 'x64') {
    return [
      ...share(custom, x86Share),
      // Debian/Ubuntu (ovmf)
      { code: '/usr/share/OVMF/OVMF_CODE_4M.fd', vars: '/usr/share/OVMF/OVMF_VARS_4M.fd' },
      { code: '/usr/share/OVMF/OVMF_CODE.fd', vars: '/usr/share/OVMF/OVMF_VARS.fd' },
      // Fedora (edk2-ovmf)
      { code: '/usr/share/edk2/ovmf/OVMF_CODE.fd', vars: '/usr/share/edk2/ovmf/OVMF_VARS.fd' },
      // Arch (edk2-ovmf)
      { code: '/usr/share/edk2/x64/OVMF_CODE.4m.fd', vars: '/usr/share/edk2/x64/OVMF_VARS.4m.fd' },
      ...share(['/usr/share/qemu', '/usr/local/share/qemu'], x86Share),
    ]
  }
  return [
    ...share(custom, aarch64Share),
    // Debian/Ubuntu (qemu-efi-aarch64)
    { code: '/usr/share/AAVMF/AAVMF_CODE.fd', vars: '/usr/share/AAVMF/AAVMF_VARS.fd' },
    // Fedora (edk2-aarch64)
    {
      code: '/usr/share/edk2/aarch64/QEMU_EFI-pflash.raw',
      vars: '/usr/share/edk2/aarch64/vars-template-pflash.raw',
    },
    // Arch (edk2-aarch64)
    { code: '/usr/share/edk2/aarch64/QEMU_CODE.fd', vars: '/usr/share/edk2/aarch64/QEMU_VARS.fd' },
    ...share(['/usr/share/qemu', '/usr/local/share/qemu'], aarch64Share),
  ]
}

/**
 * QEMU profile of a host:
 *
 * | host        | binary              | machine | accel | cpu  | firmware                    |
 * | mac arm64   | qemu-system-aarch64 | virt    | hvf   | host | edk2-aarch64                |
 * | linux x64   | qemu-system-x86_64  | q35     | kvm   | host | OVMF_CODE_4M + OVMF_VARS_4M |
 * | linux arm64 | qemu-system-aarch64 | virt    | kvm   | host | AAVMF                       |
 * | win x64     | qemu-system-x86_64  | q35     | whpx  | max  | share\edk2-x86_64-code.fd   |
 *
 * Without the accelerator it falls back to TCG (`cpu max`, `slow: true`).
 */
export function vmProfile(
  host: Pick<Host, 'platform' | 'arch'> & Partial<Pick<Host, 'env'>>,
  probe: VmProfileProbe = {},
): VmProfile {
  const platform: HostPlatform =
    host.platform === 'win32' ? 'win32' : host.platform === 'darwin' ? 'darwin' : 'linux'
  const arch: HostArch = host.arch === 'x64' ? 'x64' : 'arm64'
  const x86 = arch === 'x64'
  const preferredAccel = platform === 'darwin' ? 'hvf' : platform === 'win32' ? 'whpx' : 'kvm'
  const accelAvailable = probe.accelAvailable ?? platform !== 'linux'
  const qemuBinary = executableName(x86 ? 'qemu-system-x86_64' : 'qemu-system-aarch64', platform)
  let machine = x86 ? 'q35' : 'virt'
  let accel: string
  let cpu: string
  if (accelAvailable) {
    accel = preferredAccel === 'whpx' ? whpxAccelArg(probe.whpxKernelIrqchip) : preferredAccel
    cpu = preferredAccel === 'whpx' ? 'max' : 'host'
    if (platform === 'linux' && !x86) machine = 'virt,gic-version=host'
  } else {
    accel = 'tcg,thread=multi'
    cpu = 'max'
    // The default GICv2 stops at 8 vCPUs.
    if (!x86) machine = 'virt,gic-version=max'
  }
  const slow = !accelAvailable
  return {
    platform,
    arch,
    goldenArch: goldenArchOf(arch),
    qemuBinary,
    qemuImgBinary: executableName('qemu-img', platform),
    machine,
    accel,
    accelKind: accelAvailable ? preferredAccel : 'tcg',
    preferredAccel,
    cpu,
    firmware: firmwareCandidates(platform, arch, probe, host.env),
    qmp: platform === 'win32' ? 'tcp' : 'unix',
    slow,
    slowReason: slow
      ? probe.slowReason
        ? probe.slowReason
        : platform === 'linux'
          ? 'kvm_unavailable'
          : platform === 'win32'
            ? 'whpx_unavailable'
            : 'hvf_unavailable'
      : null,
  }
}

/** How a VM boot got past a failed first launch: WHPX missing → TCG, WHPX irqchip failure → `off`. */
export type VmBootFallback = 'tcg' | 'kernel_irqchip_off'

export interface WhpxIrqchipChoice {
  mode: WhpxKernelIrqchip
  /** Set by `MILIBOT_WHPX_KERNEL_IRQCHIP`: never changed by a fallback. */
  forced: boolean
}

/**
 * The irqchip mode of a boot: the env override, else an explicit request (`start --whpx-kernel-irqchip`),
 * else what an earlier fallback saved in the VM's config.json, else QEMU's default.
 */
export function whpxIrqchipChoice(
  env: Record<string, string | undefined>,
  requested: unknown,
  saved: unknown,
): WhpxIrqchipChoice {
  const forced = parseWhpxKernelIrqchip(env[WHPX_KERNEL_IRQCHIP_ENV])
  if (forced) return { mode: forced, forced: true }
  const explicit = parseWhpxKernelIrqchip(requested)
  if (explicit) return { mode: explicit, forced: false }
  return { mode: parseWhpxKernelIrqchip(saved) ?? 'default', forced: false }
}

/** Next attempt after QEMU exited during startup with `log` (null: nothing else to try). */
function vmBootFallback(
  profile: Pick<VmProfile, 'accelKind'>,
  irqchip: WhpxIrqchipChoice,
  log: string,
): VmBootFallback | null {
  if (profile.accelKind !== 'whpx') return null
  if (isWhpxUnavailableLog(log)) return 'tcg'
  if (!irqchip.forced && irqchip.mode !== 'off' && isWhpxIrqchipFailureLog(log)) return 'kernel_irqchip_off'
  return null
}

/** A QEMU that exited during startup (`launch` rejects with it; other errors are rethrown). */
export class VmLaunchExited extends Error {
  // No parameter properties: the VM scripts load this file with Node's type stripping.
  readonly log: string
  constructor(message: string, log: string) {
    super(message)
    this.log = log
  }
}

/**
 * Launches QEMU with the host profile and, when it exits during startup because WHPX is missing or its
 * irqchip fails, once more with TCG or `kernel-irqchip=off`. Pure: the VM script injects the launch.
 */
export async function launchWithFallback<T>(options: {
  irqchip: WhpxIrqchipChoice
  profileFor: (overrides: { tcg: boolean; whpxKernelIrqchip: WhpxKernelIrqchip }) => VmProfile
  launch: (profile: VmProfile) => Promise<T>
  /** Before the second launch (e.g. keep the first QEMU log). */
  beforeRetry?: (fallback: VmBootFallback, log: string) => void
}): Promise<{
  result: T
  profile: VmProfile
  fallback: VmBootFallback | null
  whpxKernelIrqchip: WhpxKernelIrqchip
}> {
  const { irqchip } = options
  const first = options.profileFor({ tcg: false, whpxKernelIrqchip: irqchip.mode })
  try {
    return {
      result: await options.launch(first),
      profile: first,
      fallback: null,
      whpxKernelIrqchip: irqchip.mode,
    }
  } catch (err) {
    if (!(err instanceof VmLaunchExited)) throw err
    const fallback = vmBootFallback(first, irqchip, err.log)
    if (!fallback) throw err
    options.beforeRetry?.(fallback, err.log)
    const mode = fallback === 'kernel_irqchip_off' ? 'off' : irqchip.mode
    const profile = options.profileFor({ tcg: fallback === 'tcg', whpxKernelIrqchip: mode })
    return { result: await options.launch(profile), profile, fallback, whpxKernelIrqchip: mode }
  }
}

/** `images/current.json`: `{version: 1, images: {<goldenArch>: "<file name in images/>"}}`. */
export const GOLDEN_POINTER_FILE = 'current.json'

export interface GoldenPointer {
  version: 1
  images: Partial<Record<GoldenArch, string>>
}

export function goldenFileName(version: string, arch: GoldenArch): string {
  return `debian13-golden-${version}-${arch}.qcow2`
}

const GOLDEN_NAME = /debian13-golden-(\d+)-(arm64|amd64)\.qcow2$/

export function parseGoldenFileName(file: string): { version: string; arch: GoldenArch } | null {
  const match = GOLDEN_NAME.exec(file)
  if (!match?.[1] || !match[2]) return null
  return { version: match[1], arch: match[2] as GoldenArch }
}

function parseGoldenPointer(text: string): GoldenPointer | null {
  try {
    const value = JSON.parse(text) as { images?: unknown }
    if (!value || typeof value !== 'object' || !value.images || typeof value.images !== 'object') return null
    const images: GoldenPointer['images'] = {}
    for (const arch of ['arm64', 'amd64'] as const) {
      const file = (value.images as Record<string, unknown>)[arch]
      // Only plain file names inside images/.
      if (typeof file === 'string' && /^[\w.-]+$/.test(file)) images[arch] = file
    }
    return { version: 1, images }
  } catch {
    return null
  }
}

export interface GoldenFs {
  readFile(path: string): string | null
  exists(path: string): boolean
}

/** The golden image the pointer of an `images/` dir names for an architecture; null when none or gone. */
export function resolveGoldenFile(
  imagesDir: string,
  arch: GoldenArch,
  fs: GoldenFs,
  platform: string,
): string | null {
  const pointer = parseGoldenPointer(fs.readFile(joinPath(platform, imagesDir, GOLDEN_POINTER_FILE)) ?? '')
  const name = pointer?.images[arch]
  if (!name) return null
  const file = joinPath(platform, imagesDir, name)
  return fs.exists(file) ? file : null
}

/** Pointer contents after a build of `file` for `arch` (other architectures are kept). */
export function updatedGoldenPointer(previous: string | null, arch: GoldenArch, file: string): GoldenPointer {
  const pointer = parseGoldenPointer(previous ?? '') ?? { version: 1, images: {} }
  return { version: 1, images: { ...pointer.images, [arch]: file } }
}
