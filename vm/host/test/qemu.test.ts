import { describe, expect, it } from 'vitest'

import { buildVmArgs } from '../src/golden/build.ts'
import { gvproxyConfig } from '../src/lib/gvproxy.ts'
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
        netPort: 24052,
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
    expect(argAfter(args, '-netdev')).toBe(
      'stream,id=n0,server=off,addr.type=inet,addr.host=127.0.0.1,addr.port=24052',
    )
    expect(args).toContain('virtio-net-pci,netdev=n0,mac=52:54:00:aa:bb:cc')
    expect(args.slice(-2)).toEqual(['-serial', 'file:/vm/serial.log'])
  })

  it('builds the golden VM on its own gvproxy port, without rebooting', () => {
    const args = buildVmArgs(macProfile, fw, {
      work: '/b/work.qcow2',
      vars: '/b/vars.fd',
      seed: '/b/seed.iso',
      serial: '/b/serial.log',
      cpus: 8,
      memGb: 8,
      netPort: 41234,
    })
    expect(argAfter(args, '-name')).toBe('milibot-golden-build')
    expect(argAfter(args, '-netdev')).toContain('addr.port=41234')
    expect(args).toContain('virtio-net-pci,netdev=n0,mac=52:54:00:12:34:56')
    expect(args).toContain('virtio-blk-pci,drive=sys,serial=milisys,bootindex=0')
    expect(args.at(-1)).toBe('-no-reboot')
  })
})

describe('gvproxy network', () => {
  it("serves the guest at slirp's old addresses and forwards only the given ports", () => {
    expect(gvproxyConfig({ qemuPort: 24052, mac: '52:54:00:AA:BB:CC', forwards: [[24000, 8765]] })).toEqual({
      'log-level': 'info',
      interfaces: { qemu: 'tcp://127.0.0.1:24052' },
      stack: {
        mtu: 1500,
        subnet: '10.0.2.0/24',
        gatewayIP: '10.0.2.1',
        forwards: { '127.0.0.1:24000': '10.0.2.15:8765' },
        nat: { '10.0.2.2': '127.0.0.1' },
        gatewayVirtualIPs: ['10.0.2.2'],
        dhcpStaticLeases: { '10.0.2.15': '52:54:00:aa:bb:cc' },
      },
    })
    expect(gvproxyConfig({ qemuPort: 1, mac: 'x' })).toMatchObject({ stack: { forwards: {} } })
  })
})
