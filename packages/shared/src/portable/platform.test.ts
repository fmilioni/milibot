import { describe, expect, it } from 'vitest'

import {
  bundledQemuHome,
  dataLayout,
  defaultDataRoot,
  executableCandidates,
  executableName,
  firmwareCandidates,
  goldenFileName,
  type GoldenFs,
  isWhpxIrqchipFailureLog,
  isWhpxUnavailableLog,
  joinPath,
  launchWithFallback,
  parseGoldenFileName,
  parseGoldenRevision,
  parseWhpxKernelIrqchip,
  pathDelimiter,
  QMP_TCP_OFFSET,
  resolveDataRoot,
  resolveGoldenFile,
  searchPath,
  updatedGoldenPointer,
  VmLaunchExited,
  type VmProfile,
  vmProfile,
  VNC_DISPLAYS,
  whpxAccelArg,
  whpxIrqchipChoice,
  whpxSlowReason,
  whpxUsable,
} from './platform'

const mac = { platform: 'darwin', arch: 'arm64', env: {}, homedir: '/Users/ana' }
const linux = { platform: 'linux', arch: 'x64', env: {}, homedir: '/home/ana' }
const win = { platform: 'win32', arch: 'x64', env: {}, homedir: 'C:\\Users\\ana' }

describe('data layout', () => {
  it('places the shared files under the root with the platform separator', () => {
    expect(dataLayout('/data', 'linux')).toEqual({
      root: '/data',
      daemonInfo: '/data/daemon.json',
      logsDir: '/data/logs',
      daemonLog: '/data/logs/daemon.log',
      rendererLog: '/data/logs/renderer.log',
      electronDir: '/data/electron',
    })
    expect(dataLayout('C:\\Milibot', 'win32').daemonLog).toBe('C:\\Milibot\\logs\\daemon.log')
  })
})

describe('data root', () => {
  it('uses the platform folder', () => {
    expect(defaultDataRoot(mac)).toBe('/Users/ana/Library/Application Support/Milibot')
    expect(defaultDataRoot(linux)).toBe('/home/ana/.local/share/milibot')
    expect(defaultDataRoot({ ...linux, env: { XDG_DATA_HOME: '/data/xdg' } })).toBe('/data/xdg/milibot')
    // A relative XDG_DATA_HOME is invalid per the spec.
    expect(defaultDataRoot({ ...linux, env: { XDG_DATA_HOME: 'rel' } })).toBe(
      '/home/ana/.local/share/milibot',
    )
    expect(defaultDataRoot({ ...win, env: { LOCALAPPDATA: 'D:\\Local\\', APPDATA: 'C:\\Roaming' } })).toBe(
      'D:\\Local\\Milibot',
    )
    expect(defaultDataRoot(win)).toBe('C:\\Users\\ana\\AppData\\Local\\Milibot')
  })

  it('honors MILIBOT_DATA_DIR', () => {
    expect(resolveDataRoot({ ...linux, env: { MILIBOT_DATA_DIR: '/tmp/x' } })).toBe('/tmp/x')
    expect(resolveDataRoot(linux)).toBe('/home/ana/.local/share/milibot')
  })
})

describe('paths and binaries', () => {
  it('joins and names per platform', () => {
    expect(joinPath('linux', '/a/', 'b', 'c/')).toBe('/a/b/c')
    expect(joinPath('linux', '/', 'b')).toBe('/b')
    expect(joinPath('win32', 'C:\\x\\', 'y')).toBe('C:\\x\\y')
    expect(executableName('qemu-img', 'win32')).toBe('qemu-img.exe')
    expect(executableName('qemu-img.exe', 'win32')).toBe('qemu-img.exe')
    expect(executableName('qemu-img', 'linux')).toBe('qemu-img')
    expect(pathDelimiter('win32')).toBe(';')
    expect(pathDelimiter('darwin')).toBe(':')
  })

  it('builds the search PATH', () => {
    expect(
      searchPath({ platform: 'darwin', env: { PATH: '/usr/bin:/x' } }, ['/node'])
        .split(':')
        .slice(0, 4),
    ).toEqual(['/node', '/usr/bin', '/x', '/opt/homebrew/bin'])
    const winPath = searchPath({ platform: 'win32', env: { Path: 'C:\\Windows;c:\\program files\\QEMU' } })
    expect(winPath).toBe('C:\\Windows;c:\\program files\\QEMU')
    expect(executableCandidates('qemu-img', { platform: 'win32', env: { Path: 'C:\\bin' } })).toEqual([
      'C:\\bin\\qemu-img.exe',
      'C:\\Program Files\\qemu\\qemu-img.exe',
    ])
    expect(executableCandidates('qemu-img', { platform: 'linux', env: { PATH: '/opt/q' } })[0]).toBe(
      '/opt/q/qemu-img',
    )
  })
})

describe('vmProfile', () => {
  it('matches the host table', () => {
    const m = vmProfile(mac)
    expect([m.qemuBinary, m.machine, m.accel, m.cpu, m.qmp, m.slow, m.goldenArch]).toEqual([
      'qemu-system-aarch64',
      'virt',
      'hvf',
      'host',
      'unix',
      false,
      'arm64',
    ])
    expect(m.firmware[0]).toEqual({
      code: '/opt/homebrew/share/qemu/edk2-aarch64-code.fd',
      vars: '/opt/homebrew/share/qemu/edk2-arm-vars.fd',
    })

    const lx = vmProfile(linux, { accelAvailable: true })
    expect([lx.qemuBinary, lx.machine, lx.accel, lx.cpu, lx.goldenArch]).toEqual([
      'qemu-system-x86_64',
      'q35',
      'kvm',
      'host',
      'amd64',
    ])
    expect(lx.firmware[0]).toEqual({
      code: '/usr/share/OVMF/OVMF_CODE_4M.fd',
      vars: '/usr/share/OVMF/OVMF_VARS_4M.fd',
    })

    const la = vmProfile({ platform: 'linux', arch: 'arm64' }, { accelAvailable: true })
    expect([la.qemuBinary, la.machine, la.accel, la.cpu]).toEqual([
      'qemu-system-aarch64',
      'virt,gic-version=host',
      'kvm',
      'host',
    ])
    expect(la.firmware[0]?.code).toBe('/usr/share/AAVMF/AAVMF_CODE.fd')

    const w = vmProfile(win, { qemuDir: 'D:\\qemu' })
    expect([w.qemuBinary, w.qemuImgBinary, w.machine, w.accelKind, w.cpu, w.qmp]).toEqual([
      'qemu-system-x86_64.exe',
      'qemu-img.exe',
      'q35',
      'whpx',
      'max',
      'tcp',
    ])
    expect(w.firmware[0]).toEqual({
      code: 'D:\\qemu\\share\\edk2-x86_64-code.fd',
      vars: 'D:\\qemu\\share\\edk2-i386-vars.fd',
    })
  })

  it('falls back to TCG and flags it as slow', () => {
    // Linux without a probe: no /dev/kvm assumed.
    const la = vmProfile({ platform: 'linux', arch: 'arm64' })
    expect([la.accel, la.accelKind, la.cpu, la.machine, la.slow, la.slowReason, la.preferredAccel]).toEqual([
      'tcg,thread=multi',
      'tcg',
      'max',
      'virt,gic-version=max',
      true,
      'kvm_unavailable',
      'kvm',
    ])
    const w = vmProfile(win, { accelAvailable: false })
    expect([w.accelKind, w.slowReason]).toEqual(['tcg', 'whpx_unavailable'])
    const lx = vmProfile(linux, { accelAvailable: false })
    expect(lx.machine).toBe('q35')
  })

  it("uses QEMU's default WHPX irqchip unless told otherwise", () => {
    expect(vmProfile(win).accel).toBe('whpx')
    expect(vmProfile(win, { whpxKernelIrqchip: 'off' }).accel).toBe('whpx,kernel-irqchip=off')
    expect(vmProfile(win, { whpxKernelIrqchip: 'on' }).accel).toBe('whpx,kernel-irqchip=on')
    expect(vmProfile(win, { whpxKernelIrqchip: 'off', accelAvailable: false }).accel).toBe('tcg,thread=multi')
    // Only Windows uses it.
    expect(vmProfile(linux, { accelAvailable: true, whpxKernelIrqchip: 'off' }).accel).toBe('kvm')
    expect(whpxAccelArg()).toBe('whpx')
    expect([
      parseWhpxKernelIrqchip(' OFF '),
      parseWhpxKernelIrqchip('on'),
      parseWhpxKernelIrqchip('auto'),
    ]).toEqual(['off', 'on', null])
  })

  it('tells a missing WHPX from an irqchip failure in the QEMU log', () => {
    const missing = 'qemu-system-x86_64.exe: -accel whpx: WHPX: No accelerator found, hr=00000000'
    expect([isWhpxUnavailableLog(missing), isWhpxIrqchipFailureLog(missing)]).toEqual([true, false])
    for (const log of [
      'WHPX: Failed to enable partition extended X64MsrExit and X64CpuidExit hr=80070057',
      'whpx: injection failed, MSI (0, 0) delivery: 0, dest_mode: 0, trigger mode: 0, vector: 0, lost (c0350005)',
      'WHPX: Failed to set partition property LocalApicEmulationMode',
    ]) {
      expect(isWhpxIrqchipFailureLog(log)).toBe(true)
    }
    expect(isWhpxIrqchipFailureLog('qemu: could not open disk image system.qcow2')).toBe(false)
  })

  it('tries WHPX unless the hypervisor is known to be off', () => {
    expect(
      ['enabled', 'unknown', null, 'feature_disabled', 'reboot_pending', 'virtualization_disabled'].map((s) =>
        whpxUsable(s as never),
      ),
    ).toEqual([true, true, true, false, false, false])
    expect(
      ['enabled', 'unknown', 'feature_disabled', 'reboot_pending', 'virtualization_disabled'].map((s) =>
        whpxSlowReason(s as never),
      ),
    ).toEqual([null, null, 'whpx_feature_disabled', 'whpx_reboot_pending', 'virtualization_disabled'])
    const w = vmProfile(
      { platform: 'win32', arch: 'x64' },
      { accelAvailable: false, slowReason: 'whpx_reboot_pending' },
    )
    expect([w.accelKind, w.slow, w.slowReason]).toEqual(['tcg', true, 'whpx_reboot_pending'])
  })

  it('picks the irqchip from the env, the request, then the VM config', () => {
    const env = { MILIBOT_WHPX_KERNEL_IRQCHIP: 'on' }
    expect(whpxIrqchipChoice(env, 'off', 'off')).toEqual({ mode: 'on', forced: true })
    expect(whpxIrqchipChoice({}, 'off', undefined)).toEqual({ mode: 'off', forced: false })
    expect(whpxIrqchipChoice({}, undefined, 'off')).toEqual({ mode: 'off', forced: false })
    expect(whpxIrqchipChoice({ MILIBOT_WHPX_KERNEL_IRQCHIP: 'auto' }, true, 'bogus')).toEqual({
      mode: 'default',
      forced: false,
    })
  })

  describe('launchWithFallback', () => {
    const profileFor = (o: { tcg: boolean; whpxKernelIrqchip: 'default' | 'on' | 'off' }) =>
      vmProfile(win, { accelAvailable: !o.tcg, whpxKernelIrqchip: o.whpxKernelIrqchip })
    const run = (logs: (string | null)[], irqchip = { mode: 'default' as const, forced: false }) => {
      const tried: string[] = []
      const retries: string[] = []
      const promise = launchWithFallback({
        irqchip: irqchip as { mode: 'default' | 'on' | 'off'; forced: boolean },
        profileFor,
        beforeRetry: (fallback) => retries.push(fallback),
        launch: async (profile: VmProfile) => {
          tried.push(profile.accel)
          const log = logs[tried.length - 1]
          if (log) throw new VmLaunchExited(`qemu failed to start: ${log}`, log)
          return 'qemu'
        },
      })
      return { promise, tried, retries }
    }

    it("boots with QEMU's default first", async () => {
      const r = run([null])
      await expect(r.promise).resolves.toMatchObject({ fallback: null, whpxKernelIrqchip: 'default' })
      expect(r.tried).toEqual(['whpx'])
    })

    it('retries with kernel-irqchip=off after an irqchip failure', async () => {
      const r = run(['WHPX: Failed to set partition property LocalApicEmulationMode', null])
      const out = await r.promise
      expect([out.fallback, out.whpxKernelIrqchip, out.profile.accel]).toEqual([
        'kernel_irqchip_off',
        'off',
        'whpx,kernel-irqchip=off',
      ])
      expect(r.tried).toEqual(['whpx', 'whpx,kernel-irqchip=off'])
      expect(r.retries).toEqual(['kernel_irqchip_off'])
    })

    it('falls back to TCG when WHPX is missing', async () => {
      const r = run(['WHPX: No accelerator found, hr=80004005', null])
      const out = await r.promise
      expect([out.fallback, out.profile.accelKind, out.profile.slow, out.profile.slowReason]).toEqual([
        'tcg',
        'tcg',
        true,
        'whpx_unavailable',
      ])
    })

    it('never overrides a forced irqchip and gives up on unrelated failures', async () => {
      const forced = run(['WHPX: Failed to set partition property', null], {
        mode: 'on',
        forced: true,
      } as never)
      await expect(forced.promise).rejects.toBeInstanceOf(VmLaunchExited)
      expect(forced.tried).toEqual(['whpx,kernel-irqchip=on'])
      const disk = run(['could not open system.qcow2', null])
      await expect(disk.promise).rejects.toThrow(/system.qcow2/)
      // Only one retry: a second failure is the error.
      const twice = run(['WHPX: Failed to set partition property', 'WHPX: Failed to set partition property'])
      await expect(twice.promise).rejects.toBeInstanceOf(VmLaunchExited)
      expect(twice.tried).toHaveLength(2)
    })

    it('rethrows errors other than an early exit', async () => {
      const promise = launchWithFallback({
        irqchip: { mode: 'default', forced: false },
        profileFor,
        launch: async () => {
          throw new Error('ports busy')
        },
      })
      await expect(promise).rejects.toThrow('ports busy')
    })
  })

  it('runs the bundled QEMU with its own firmware and data folder', () => {
    const mac = vmProfile({ platform: 'darwin', arch: 'arm64' }, { qemuHome: '/app/vm/bin/qemu' })
    expect(mac.qemuBinary).toBe('/app/vm/bin/qemu/bin/qemu-system-aarch64')
    expect(mac.qemuImgBinary).toBe('/app/vm/bin/qemu/bin/qemu-img')
    expect(mac.qemuDataDir).toBe('/app/vm/bin/qemu/share/qemu')
    expect(mac.firmware[0]?.code).toBe('/app/vm/bin/qemu/share/qemu/edk2-aarch64-code.fd')
    const win = vmProfile({ platform: 'win32', arch: 'x64' }, { qemuHome: 'C:\\M\\vm\\bin\\qemu' })
    expect(win.qemuBinary).toBe('C:\\M\\vm\\bin\\qemu\\bin\\qemu-system-x86_64.exe')
    expect(win.firmware[0]?.vars).toBe('C:\\M\\vm\\bin\\qemu\\share\\qemu\\edk2-i386-vars.fd')
    const system = vmProfile({ platform: 'linux', arch: 'x64' })
    expect(system).toMatchObject({ qemuBinary: 'qemu-system-x86_64', qemuDataDir: null })
    expect(bundledQemuHome('/repo/vm', 'linux')).toBe('/repo/vm/bin/qemu')
    expect(bundledQemuHome('/repo/vm', 'linux', { MILIBOT_QEMU_HOME: '/q' })).toBe('/q')
  })

  it('tries MILIBOT_QEMU_SHARE first', () => {
    expect(firmwareCandidates('linux', 'x64', { qemuShare: '/q' })[0]).toEqual({
      code: '/q/edk2-x86_64-code.fd',
      vars: '/q/edk2-i386-vars.fd',
    })
  })

  it('looks for the Windows firmware under %ProgramFiles%', () => {
    const dirs = (env: Record<string, string>) =>
      vmProfile({ platform: 'win32', arch: 'x64', env }, { qemuDir: 'E:\\tools\\qemu' }).firmware.map(
        (f) => f.code,
      )
    expect(dirs({ ProgramFiles: 'D:\\Programs' })).toEqual([
      'E:\\tools\\qemu\\share\\edk2-x86_64-code.fd',
      'D:\\Programs\\qemu\\share\\edk2-x86_64-code.fd',
    ])
    expect(dirs({})[1]).toBe('C:\\Program Files\\qemu\\share\\edk2-x86_64-code.fd')
  })
})

describe('golden pointer', () => {
  const fakeFs = (files: Record<string, string>): GoldenFs => ({
    readFile: (p) => files[p] ?? null,
    exists: (p) => p in files,
  })

  it('parses file names', () => {
    expect(goldenFileName('202609281200', 'amd64')).toBe('debian13-golden-202609281200-amd64.qcow2')
    expect(parseGoldenFileName('/i/debian13-golden-202609281200-amd64.qcow2')).toEqual({
      version: '202609281200',
      arch: 'amd64',
    })
    expect(parseGoldenFileName('/i/debian13-golden-202601010000.qcow2')).toBeNull()
    expect(parseGoldenFileName('/i/other.qcow2')).toBeNull()
  })

  it('resolves the pointer per architecture', () => {
    const pointer = JSON.stringify({ version: 1, images: { amd64: 'debian13-golden-2-amd64.qcow2' } })
    const fs = fakeFs({ '/i/current.json': pointer, '/i/debian13-golden-2-amd64.qcow2': 'x' })
    expect(resolveGoldenFile('/i', 'amd64', fs, 'linux')).toBe('/i/debian13-golden-2-amd64.qcow2')
    expect(resolveGoldenFile('/i', 'arm64', fs, 'darwin')).toBeNull()
    expect(resolveGoldenFile('/empty', 'amd64', fakeFs({}), 'linux')).toBeNull()
    // A pointer to a deleted file is ignored.
    const stale = fakeFs({ '/i/current.json': pointer })
    expect(resolveGoldenFile('/i', 'amd64', stale, 'linux')).toBeNull()
  })

  it('rejects pointer entries outside images/', () => {
    const fs = fakeFs({
      '/i/current.json': JSON.stringify({ images: { amd64: '../../etc/passwd' } }),
      '/etc/passwd': 'x',
    })
    expect(resolveGoldenFile('/i', 'amd64', fs, 'linux')).toBeNull()
  })

  it('keeps the other architectures when updating', () => {
    const previous = JSON.stringify({ version: 1, images: { arm64: 'a.qcow2' } })
    expect(updatedGoldenPointer(previous, 'amd64', 'b.qcow2')).toEqual({
      version: 1,
      images: { arm64: 'a.qcow2', amd64: 'b.qcow2' },
    })
    expect(updatedGoldenPointer('garbage', 'amd64', 'b.qcow2').images).toEqual({ amd64: 'b.qcow2' })
  })
})

describe('VM constants', () => {
  it('puts the QMP port right after the VNC ports', () => {
    expect(QMP_TCP_OFFSET).toBe(VNC_DISPLAYS + 1)
  })

  it('parses vm/golden-revision, falling back to 1', () => {
    expect(parseGoldenRevision('7\n')).toBe(7)
    expect(parseGoldenRevision('')).toBe(1)
    expect(parseGoldenRevision('0')).toBe(1)
    expect(parseGoldenRevision('2.5')).toBe(1)
    expect(parseGoldenRevision('abc')).toBe(1)
  })
})
