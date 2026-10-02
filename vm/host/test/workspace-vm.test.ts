import { describe, expect, it } from 'vitest'

import { parseArgs } from '../src/lib/args.ts'
import {
  gvproxyIdentity,
  isGvproxyImage,
  isQemuImage,
  parsePsComm,
  parseTasklistCsv,
  qemuIdentity,
} from '../src/lib/proc.ts'
import { vmProfile } from '../src/lib/shared.ts'
import { vmRootDir } from '../src/lib/vm-root.ts'
import { sanitizeName } from '../src/workspace/commands/create.ts'
import { chooseFirmware } from '../src/workspace/firmware.ts'
import { maxPortBase, requiredPorts } from '../src/workspace/ports.ts'
import { qemuArgs, vmForwards } from '../src/workspace/qemu-process.ts'
import { seedFiles } from '../src/workspace/seed.ts'

const macHost = { platform: 'darwin', arch: 'arm64', env: {}, homedir: '/Users/me' }
const winHost = { platform: 'win32', arch: 'x64', env: {}, homedir: 'C:\\Users\\me' }

const vmPaths = {
  system: '/ws/vm/system.qcow2',
  data: '/ws/vm/data.qcow2',
  vars: '/ws/vm/efi-vars.fd',
  seed: '/ws/vm/seed.iso',
  serial: '/ws/vm/serial.log',
  pid: '/ws/vm/qemu.pid',
}
const config = { name: 'demo', cpus: 4, memGb: 8, portBase: 24000, macAddress: '52:54:00:aa:bb:cc' }
const fw = { code: '/fw/code.fd', vars: '/fw/vars.fd' }

const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

describe('workspace VM command line', () => {
  it('parses flags in both spellings', () => {
    expect(parseArgs(['start', '/ws', '--wait', '--timeout-sec', '30', '--whpx-kernel-irqchip=off'])).toEqual(
      {
        positional: ['start', '/ws'],
        flags: { wait: true, 'timeout-sec': '30', 'whpx-kernel-irqchip': 'off' },
      },
    )
  })

  it('uses a unix QMP socket on macOS and TCP after the VNC ports on Windows', () => {
    const mac = qemuArgs(vmPaths, config, fw, vmProfile(macHost))
    expect(argAfter(mac, '-qmp')).toBe('unix:qmp.sock,server=on,wait=off')
    const win = qemuArgs(vmPaths, config, fw, vmProfile(winHost))
    expect(argAfter(win, '-qmp')).toBe('tcp:127.0.0.1:24051,server=on,wait=off')
  })

  it('connects the NIC to gvproxy after the QMP port', () => {
    const args = qemuArgs(vmPaths, config, fw, vmProfile(macHost))
    expect(argAfter(args, '-netdev')).toContain('addr.host=127.0.0.1,addr.port=24052')
    expect(args).toContain('virtio-net-pci,netdev=n0,mac=52:54:00:aa:bb:cc')
    expect(args).toContain(`if=pflash,format=raw,readonly=on,file=${fw.code}`)
  })

  it('forwards the agent and 50 VNC displays from the port base', () => {
    const forwards = vmForwards(24000)
    expect(forwards).toHaveLength(51)
    expect(forwards[0]).toEqual([24000, 8765])
    expect(forwards[1]).toEqual([24001, 5901])
    expect(forwards.at(-1)).toEqual([24050, 5950])
  })

  it("checks the QMP port only on Windows, and gvproxy's port everywhere", () => {
    const mac = requiredPorts(24000, vmProfile(macHost))
    expect(mac).toHaveLength(52)
    expect(mac).not.toContain(24051)
    expect(mac.at(-1)).toBe(24052)
    expect(requiredPorts(24000, vmProfile(winHost))).toHaveLength(53)
  })

  it('keeps every bound port below 65536', () => {
    for (const host of [macHost, winHost]) {
      expect(requiredPorts(maxPortBase(), vmProfile(host)).at(-1)).toBe(65535)
    }
    expect(maxPortBase()).toBe(65483)
  })

  it('parses flags of both CLIs the same way', () => {
    expect(parseArgs(['--rebuild', '--cpus=4', '--mem-gb', '8', '-h'])).toEqual({
      positional: [],
      flags: { rebuild: true, cpus: '4', 'mem-gb': '8', help: true },
    })
  })

  it('names the VM after the workspace folder', () => {
    expect(sanitizeName('My Workspace!')).toBe('my-workspace')
    expect(sanitizeName('---')).toBe('workspace')
    expect(sanitizeName('a'.repeat(39) + '-b')).toBe('a'.repeat(39))
  })

  it('seeds the hostname, the token and the quoted workspace name', () => {
    const files = seedFiles({ name: "it's", hostname: 'milibot-its', instanceId: 'milibot-its-1' }, 'tok')
    expect(files['meta-data']).toBe('instance-id: milibot-its-1\nlocal-hostname: milibot-its\n')
    expect(files['user-data']).toContain('    content: tok\n')
    expect(files['user-data']).toContain(`content: '{"name":"it''s","hostname":"milibot-its"}'`)
  })

  it('finds the vm/ folder from sources, the packaged bundle and shortcuts', () => {
    expect(vmRootDir('/r/vm/host/src/cli/workspace-vm.ts')).toBe('/r/vm')
    expect(vmRootDir('/r/Resources/vm/scripts/workspace-vm.mjs')).toBe('/r/Resources/vm')
    expect(vmRootDir('/r/vm/workspace-vm.sh')).toBe('/r/vm')
  })

  describe('firmware pinning', () => {
    const candidates = [
      { code: '/a/code.fd', vars: '/a/vars.fd' },
      { code: '/b/code.fd', vars: '/b/vars.fd' },
    ]
    const sizes =
      (map: Record<string, number>) =>
      (file: string): number | null =>
        map[file] ?? null

    it('keeps the saved pair while its code file is unchanged', () => {
      const saved = { code: '/b/code.fd', vars: '/b/vars.fd', codeSize: 2048 }
      const sizeOf = sizes({ '/a/code.fd': 1, '/a/vars.fd': 1, '/b/code.fd': 2048, '/b/vars.fd': 1 })
      expect(chooseFirmware(saved, candidates, sizeOf)).toEqual({
        pair: { code: '/b/code.fd', vars: '/b/vars.fd' },
        codeSize: 2048,
        recreateVars: false,
      })
    })

    it('switches pairs and recreates the vars when the saved code changed or is gone', () => {
      const saved = { code: '/b/code.fd', vars: '/b/vars.fd', codeSize: 2048 }
      const resized = sizes({ '/a/code.fd': 1, '/a/vars.fd': 1, '/b/code.fd': 4096, '/b/vars.fd': 1 })
      expect(chooseFirmware(saved, candidates, resized)).toEqual({
        pair: candidates[0],
        codeSize: 1,
        recreateVars: true,
      })
      const gone = sizes({ '/a/code.fd': 1, '/a/vars.fd': 1 })
      expect(chooseFirmware(saved, candidates, gone)?.recreateVars).toBe(true)
    })

    it('picks the first installed pair for a new VM', () => {
      const sizeOf = sizes({ '/b/code.fd': 3, '/b/vars.fd': 1 })
      expect(chooseFirmware(undefined, candidates, sizeOf)).toEqual({
        pair: candidates[1],
        codeSize: 3,
        recreateVars: false,
      })
      expect(chooseFirmware(undefined, candidates, sizes({}))).toBeNull()
    })
  })
})

describe('VM process identity', () => {
  it('reads process names from ps and tasklist', () => {
    expect(parsePsComm('/opt/homebrew/bin/qemu-system-aarch64\n')).toBe('qemu-system-aarch64')
    expect(parsePsComm('qemu-system-x86\n')).toBe('qemu-system-x86')
    expect(parsePsComm('\n')).toBeNull()
    expect(parseTasklistCsv('"qemu-system-x86_64.exe","4212","Console","1","2.104.332 K"\r\n')).toBe(
      'qemu-system-x86_64.exe',
    )
    expect(parseTasklistCsv('INFO: No tasks are running which match the specified criteria.\r\n')).toBeNull()
  })

  it('only accepts QEMU system emulators', () => {
    expect(isQemuImage('qemu-system-aarch64')).toBe(true)
    expect(isQemuImage('QEMU-SYSTEM-X86_64.EXE')).toBe(true)
    expect(isQemuImage('explorer.exe')).toBe(false)
    expect(isQemuImage('qemu-img')).toBe(false)
  })

  it('recognizes gvproxy on every host', () => {
    expect(isGvproxyImage('gvproxy')).toBe(true)
    expect(isGvproxyImage('GVPROXY.EXE')).toBe(true)
    expect(isGvproxyImage('gvproxy-darwin')).toBe(false)
  })

  it('does not take a live unrelated pid for QEMU or gvproxy', () => {
    expect(qemuIdentity(process.pid)).toBe('no')
    expect(gvproxyIdentity(process.pid)).toBe('no')
  })
})
