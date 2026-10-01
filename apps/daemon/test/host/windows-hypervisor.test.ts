import type { execFile } from 'node:child_process'

import type { WindowsHypervisorState } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { qemuStatus, vmAccelInfo } from '../../src/host/info'
import {
  powershellHypervisorFacts,
  probeWindowsHypervisor,
  type WindowsHypervisorDeps,
  WindowsHypervisorProbe,
} from '../../src/host/windows-hypervisor'

const DLL = 'C:\\Windows\\System32\\WinHvPlatform.dll'

type Facts = { present: boolean | null; firmware?: boolean | null } | Error

function deps(options: { dll: boolean; facts?: Facts }): WindowsHypervisorDeps & {
  checks: number
} {
  const out = {
    checks: 0,
    systemRoot: 'C:\\Windows',
    // path.join on this (POSIX) test host joins with '/': compare by the file name parts.
    exists: (path: string) => options.dll && path.replaceAll('/', '\\') === DLL,
    facts: async () => {
      out.checks++
      const f = options.facts ?? { present: true }
      if (f instanceof Error) throw f
      return { hypervisorPresent: f.present, virtualizationFirmwareEnabled: f.firmware ?? null }
    },
  }
  return out
}

describe('Windows Hypervisor Platform probe', () => {
  const state = (dll: boolean, facts: Facts) => probeWindowsHypervisor(deps({ dll, facts }))

  it('reports each state', async () => {
    expect(await state(true, { present: true })).toBe('enabled')
    expect(await state(false, { present: true })).toBe('feature_disabled')
    expect(await state(false, { present: false, firmware: true })).toBe('feature_disabled')
    expect(await state(true, { present: false, firmware: true })).toBe('reboot_pending')
    expect(await state(true, { present: false, firmware: null })).toBe('reboot_pending')
    expect(await state(true, { present: null })).toBe('unknown')
    expect(await state(true, new Error('boom'))).toBe('unknown')
    expect(await state(false, new Error('boom'))).toBe('feature_disabled')
  })

  it('puts virtualization off in the firmware before the feature', async () => {
    expect(await state(false, { present: false, firmware: false })).toBe('virtualization_disabled')
    expect(await state(true, { present: false, firmware: false })).toBe('virtualization_disabled')
    // With a hypervisor running the firmware flag reads false but means nothing.
    expect(await state(true, { present: true, firmware: false })).toBe('enabled')
  })

  it('caches the result for a short time and runs one check at a time', async () => {
    let now = 1000
    const d = deps({ dll: true })
    const probe = new WindowsHypervisorProbe(d, 15_000, () => now)
    expect(probe.lastKnown()).toBeNull()
    expect(await Promise.all([probe.get(), probe.get()])).toEqual(['enabled', 'enabled'])
    expect(d.checks).toBe(1)
    now += 10_000
    await probe.get()
    expect(d.checks).toBe(1)
    now += 10_000
    await probe.get()
    expect(d.checks).toBe(2)
    expect(probe.lastKnown()).toBe('enabled')
  })

  it('reads both WMI facts through a hidden PowerShell without a profile', async () => {
    const calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = []
    const fake = (stdout: string, error: Error | null = null) =>
      ((
        file: string,
        args: string[],
        options: Record<string, unknown>,
        cb: (e: Error | null, out: string, err: string) => void,
      ) => {
        calls.push({ file, args, options })
        cb(error, stdout, '')
      }) as unknown as typeof execFile
    const facts = (present: boolean | null, firmware: boolean | null) => ({
      hypervisorPresent: present,
      virtualizationFirmwareEnabled: firmware,
    })
    expect(
      await powershellHypervisorFacts({ SystemRoot: 'C:\\Windows' }, 5000, fake('True,False\r\n')),
    ).toEqual(facts(true, false))
    expect(await powershellHypervisorFacts({}, 5000, fake('False,True\r\n'))).toEqual(facts(false, true))
    expect(await powershellHypervisorFacts({}, 5000, fake('False,\r\n'))).toEqual(facts(false, null))
    expect(await powershellHypervisorFacts({}, 5000, fake(''))).toEqual(facts(null, null))
    expect(await powershellHypervisorFacts({}, 5000, fake('True,True', new Error('timeout')))).toEqual(
      facts(null, null),
    )
    expect(calls[0]?.args.slice(0, 2)).toEqual(['-NoProfile', '-NonInteractive'])
    expect(calls[0]?.args.at(-1)).toContain('Win32_ComputerSystem')
    expect(calls[0]?.args.at(-1)).toContain('VirtualizationFirmwareEnabled')
    expect(calls[0]?.options).toMatchObject({ windowsHide: true, timeout: 5000 })
  })
})

describe('vmAccel on Windows', () => {
  const host = { platform: 'win32', arch: 'x64', env: {}, homedir: 'C:\\Users\\ana' }

  it('falls back to TCG only when the hypervisor is known to be off, with the agreed reasons', () => {
    const accel = (state?: WindowsHypervisorState) => vmAccelInfo({}, state, host).vmAccel
    for (const state of [undefined, 'enabled', 'unknown'] as const) {
      expect(accel(state)).toEqual({ kind: 'whpx', preferred: 'whpx', slow: false, reason: null })
    }
    const reasons: Array<[WindowsHypervisorState, string]> = [
      ['feature_disabled', 'whpx_feature_disabled'],
      ['reboot_pending', 'whpx_reboot_pending'],
      ['virtualization_disabled', 'virtualization_disabled'],
    ]
    for (const [state, reason] of reasons) {
      expect(accel(state)).toEqual({ kind: 'tcg', preferred: 'whpx', slow: true, reason })
    }
    expect(vmAccelInfo({}, 'enabled', host).platform).toEqual({ os: 'win32', arch: 'x64' })
  })
})

describe('QEMU on Windows', () => {
  const host = { platform: 'win32', arch: 'x64', env: {}, homedir: 'C:\\Users\\ana' }
  const winget = 'C:\\Program Files\\qemu'

  it('finds the winget install in Program Files when it is not on the PATH', () => {
    const installed = new Set([
      `${winget}\\qemu-system-x86_64.exe`,
      `${winget}\\qemu-img.exe`,
      `${winget}\\share\\edk2-x86_64-code.fd`,
      `${winget}\\share\\edk2-i386-vars.fd`,
    ])
    const isFile = (file: string) => installed.has(file)
    const env = { Path: 'C:\\Windows\\System32;C:\\Windows' }
    expect(qemuStatus(env, { ...host, env }, isFile, isFile)).toMatchObject({
      found: true,
      path: `${winget}\\qemu-system-x86_64.exe`,
      binary: 'qemu-system-x86_64.exe',
      firmware: { found: true },
    })
    // Another Program Files (%ProgramFiles% set) is honoured.
    const envD = { ...env, ProgramFiles: 'D:\\Apps' }
    const onD = new Set([
      'D:\\Apps\\qemu\\qemu-system-x86_64.exe',
      'D:\\Apps\\qemu\\qemu-img.exe',
      'D:\\Apps\\qemu\\share\\edk2-x86_64-code.fd',
      'D:\\Apps\\qemu\\share\\edk2-i386-vars.fd',
    ])
    const onDrive = (f: string) => onD.has(f)
    expect(qemuStatus(envD, { ...host, env: envD }, onDrive, onDrive).found).toBe(true)
  })

  it('reports QEMU missing until both binaries are there', () => {
    const env = { Path: 'C:\\Windows' }
    const only = new Set([`${winget}\\qemu-system-x86_64.exe`])
    expect(
      qemuStatus(
        env,
        { ...host, env },
        () => false,
        () => false,
      ),
    ).toMatchObject({
      found: false,
      path: null,
      binary: 'qemu-system-x86_64.exe',
    })
    expect(qemuStatus(env, { ...host, env }, (f) => only.has(f)).found).toBe(false)
  })
})
