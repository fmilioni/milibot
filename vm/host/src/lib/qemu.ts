// QEMU command line and cloud-init pieces shared by the golden build and the workspace VMs.
import { streamNetdev } from './gvproxy.ts'
import type { FirmwarePair, VmProfile } from './shared.ts'

/** Commas in a `-drive`/`-serial` option value are escaped by doubling them. */
export function escapeOpt(value: string): string {
  return value.replaceAll(',', ',,')
}

interface QemuDisk {
  id: string
  file: string
  serial: string
}

export interface BaseVm {
  name: string
  cpus: number
  memGb: number
  vars: string
  /** The first one boots. */
  disks: QemuDisk[]
  seed: string
  /** gvproxy's loopback port for QEMU. */
  netPort: number
  mac: string
  serial: string
}

/** Headless VM with UEFI firmware, virtio disks, the cidata seed, gvproxy's network and a serial log. */
export function baseQemuArgs(
  prof: Pick<VmProfile, 'machine' | 'accel' | 'cpu' | 'qemuDataDir'>,
  fw: Pick<FirmwarePair, 'code'>,
  vm: BaseVm,
): string[] {
  const disk = ({ id, file, serial }: QemuDisk, i: number) => [
    '-drive',
    `if=none,id=${id},file=${escapeOpt(file)},format=qcow2,discard=unmap,detect-zeroes=unmap,cache=writeback`,
    '-device',
    `virtio-blk-pci,drive=${id},serial=${serial}${i === 0 ? ',bootindex=0' : ''}`,
  ]
  return [
    ...(prof.qemuDataDir ? ['-L', prof.qemuDataDir] : []),
    '-name',
    vm.name,
    '-machine',
    prof.machine,
    '-accel',
    prof.accel,
    '-cpu',
    prof.cpu,
    '-smp',
    String(vm.cpus),
    '-m',
    `${vm.memGb}G`,
    '-drive',
    `if=pflash,format=raw,readonly=on,file=${escapeOpt(fw.code)}`,
    '-drive',
    `if=pflash,format=raw,file=${escapeOpt(vm.vars)}`,
    ...vm.disks.flatMap(disk),
    '-drive',
    `if=none,id=seed,file=${escapeOpt(vm.seed)},format=raw,readonly=on`,
    '-device',
    'virtio-blk-pci,drive=seed,serial=miliseed',
    '-netdev',
    streamNetdev('n0', vm.netPort),
    '-device',
    `virtio-net-pci,netdev=n0,mac=${vm.mac}`,
    '-device',
    'virtio-rng-pci',
    '-display',
    'none',
    '-monitor',
    'none',
    '-serial',
    `file:${escapeOpt(vm.serial)}`,
  ]
}

/** cloud-config lines every seed carries: no users or SSH logins, no package runs at boot. */
export const CLOUD_CONFIG_BASE = [
  'users: []',
  'disable_root: true',
  'ssh_pwauth: false',
  'package_update: false',
  'package_upgrade: false',
]
