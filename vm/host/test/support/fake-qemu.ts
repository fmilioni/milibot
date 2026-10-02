import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { goldenFileName, vmProfile } from '../../src/lib/shared.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

export interface FakeQemuHost {
  env: NodeJS.ProcessEnv
  golden: string
  home: string
}

/**
 * A bundled QEMU (`MILIBOT_QEMU_HOME`) with fake `qemu-img` and `qemu-system-*` and UEFI firmware, a fake
 * gvproxy (`MILIBOT_GVPROXY`) and a golden image, all under `root`. QEMU and gvproxy run through symlinks to
 * Node named like them and take that name as their process title, so pid identity checks see the real
 * programs.
 */
export function fakeQemuHost(root: string): FakeQemuHost {
  const qemu = path.join(root, 'qemu')
  const bin = path.join(qemu, 'bin')
  const share = path.join(qemu, 'share', 'qemu')
  const exe = path.join(root, 'exe')
  const home = path.join(root, 'home')
  for (const dir of [bin, exe, share, path.join(home, 'images')]) fs.mkdirSync(dir, { recursive: true })
  const prof = vmProfile({ platform: process.platform, arch: process.arch })
  for (const name of [prof.qemuBinary, 'gvproxy']) fs.symlinkSync(process.execPath, path.join(exe, name))
  const stub = (file: string, command: string) =>
    fs.writeFileSync(file, `#!/bin/sh\nexec ${command} "$@"\n`, { mode: 0o755 })
  stub(
    path.join(bin, prof.qemuBinary),
    `"${path.join(exe, prof.qemuBinary)}" "${path.join(here, 'fake-qemu-system.mjs')}"`,
  )
  stub(path.join(bin, 'qemu-img'), `"${process.execPath}" "${path.join(here, 'fake-qemu-img.mjs')}"`)
  stub(path.join(root, 'gvproxy'), `"${path.join(exe, 'gvproxy')}" "${path.join(here, 'fake-gvproxy.mjs')}"`)
  for (const name of ['edk2-aarch64-code.fd', 'edk2-arm-vars.fd', 'edk2-x86_64-code.fd', 'edk2-i386-vars.fd'])
    fs.writeFileSync(path.join(share, name), Buffer.alloc(name.includes('code') ? 4096 : 1024))
  const golden = path.join(home, 'images', goldenFileName('202609300000', prof.goldenArch))
  fs.writeFileSync(golden, JSON.stringify({ virtualSize: 40 * 1024 ** 3, snapshots: [] }))
  return {
    home,
    golden,
    env: {
      ...process.env,
      MILIBOT_HOME: home,
      MILIBOT_QEMU_HOME: qemu,
      MILIBOT_GVPROXY: path.join(root, 'gvproxy'),
      MILIBOT_VM_ACCEL: 'tcg',
    },
  }
}
