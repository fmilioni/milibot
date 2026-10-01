import path from 'node:path'

export interface VmPaths {
  vm: string
  config: string
  system: string
  data: string
  vars: string
  seed: string
  token: string
  qmp: string
  pid: string
  serial: string
  qemuLog: string
}

export function vmPaths(wsDir: string): VmPaths {
  const vm = path.join(path.resolve(wsDir), 'vm')
  return {
    vm,
    config: path.join(vm, 'config.json'),
    system: path.join(vm, 'system.qcow2'),
    data: path.join(vm, 'data.qcow2'),
    vars: path.join(vm, 'efi-vars.fd'),
    seed: path.join(vm, 'seed.iso'),
    token: path.join(vm, 'agent.token'),
    qmp: path.join(vm, 'qmp.sock'),
    pid: path.join(vm, 'qemu.pid'),
    serial: path.join(vm, 'serial.log'),
    qemuLog: path.join(vm, 'qemu.log'),
  }
}
