import { describe, expect, it } from 'vitest'

import { buildVmArgs } from '../src/golden/build.ts'
import { baseQemuArgs, escapeOpt } from '../src/lib/qemu.ts'
import { vmProfile } from '../src/lib/shared.ts'

const macProfile = vmProfile({ platform: 'darwin', arch: 'arm64' })
const fw = { code: '/fw/code.fd', vars: '/fw/vars.fd' }
const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

describe('VM script QEMU arguments', () => {
  it('doubles commas in option values', () => {
    expect(escapeOpt('/a,b/c,,d')).toBe('/a,,b/c,,,,d')
  })

  it('boots from the first disk and escapes every path', () => {
    const args = baseQemuArgs(
      macProfile,
      { code: '/fw,x/code.fd' },
      {
        name: 'milibot-demo',
        cpus: 2,
        memGb: 4,
        vars: '/vm/vars.fd',
        disks: [
          { id: 'sys', file: '/v,m/system.qcow2', serial: 'milisys' },
          { id: 'data', file: '/vm/data.qcow2', serial: 'milidata' },
        ],
        seed: '/vm/seed.iso',
        hostfwd: ['hostfwd=tcp:127.0.0.1:24000-:8765'],
        mac: '52:54:00:aa:bb:cc',
        serial: '/vm/serial.log',
      },
    )
    expect(args.slice(0, 12)).toEqual([
      '-name',
      'milibot-demo',
      '-machine',
      macProfile.machine,
      '-accel',
      macProfile.accel,
      '-cpu',
      macProfile.cpu,
      '-smp',
      '2',
      '-m',
      '4G',
    ])
    expect(args).toContain('if=pflash,format=raw,readonly=on,file=/fw,,x/code.fd')
    expect(args).toContain(
      'if=none,id=sys,file=/v,,m/system.qcow2,format=qcow2,discard=unmap,detect-zeroes=unmap,cache=writeback',
    )
    expect(args).toContain('virtio-blk-pci,drive=sys,serial=milisys,bootindex=0')
    expect(args).toContain('virtio-blk-pci,drive=data,serial=milidata')
    expect(argAfter(args, '-netdev')).toBe('user,id=n0,hostfwd=tcp:127.0.0.1:24000-:8765')
    expect(args).toContain('virtio-net-pci,netdev=n0,mac=52:54:00:aa:bb:cc')
    expect(args.slice(-2)).toEqual(['-serial', 'file:/vm/serial.log'])
  })

  it('builds the golden VM without forwarded ports and without rebooting', () => {
    const args = buildVmArgs(macProfile, fw, {
      work: '/b/work.qcow2',
      vars: '/b/vars.fd',
      seed: '/b/seed.iso',
      serial: '/b/serial.log',
      cpus: 8,
      memGb: 8,
    })
    expect(argAfter(args, '-name')).toBe('milibot-golden-build')
    expect(argAfter(args, '-netdev')).toBe('user,id=n0')
    expect(args).toContain('virtio-net-pci,netdev=n0')
    expect(args).toContain('virtio-blk-pci,drive=sys,serial=milisys,bootindex=0')
    expect(args.at(-1)).toBe('-no-reboot')
  })
})
