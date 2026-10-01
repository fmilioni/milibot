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
 * A PATH with fake `qemu-img` and `qemu-system-*` (the latter runs through a symlink to Node named like QEMU
 * and takes that name as its process title, so pid identity checks see a QEMU), UEFI firmware files and a
 * golden image, all under `root`.
 */
export function fakeQemuHost(root: string): FakeQemuHost {
  const bin = path.join(root, 'bin')
  const exe = path.join(root, 'exe')
  const share = path.join(root, 'share')
  const home = path.join(root, 'home')
  for (const dir of [bin, exe, share, path.join(home, 'images')]) fs.mkdirSync(dir, { recursive: true })
  const prof = vmProfile({ platform: process.platform, arch: process.arch })
  fs.symlinkSync(process.execPath, path.join(exe, prof.qemuBinary))
  const stub = (name: string, command: string) =>
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec ${command} "$@"\n`, { mode: 0o755 })
  stub(prof.qemuBinary, `"${path.join(exe, prof.qemuBinary)}" "${path.join(here, 'fake-qemu-system.mjs')}"`)
  stub('qemu-img', `"${process.execPath}" "${path.join(here, 'fake-qemu-img.mjs')}"`)
  for (const name of ['edk2-aarch64-code.fd', 'edk2-arm-vars.fd', 'edk2-x86_64-code.fd', 'edk2-i386-vars.fd'])
    fs.writeFileSync(path.join(share, name), Buffer.alloc(name.includes('code') ? 4096 : 1024))
  const golden = path.join(home, 'images', goldenFileName('202609300000', prof.goldenArch))
  fs.writeFileSync(golden, JSON.stringify({ virtualSize: 40 * 1024 ** 3, snapshots: [] }))
  return {
    home,
    golden,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      MILIBOT_HOME: home,
      MILIBOT_QEMU_SHARE: share,
      MILIBOT_VM_ACCEL: 'tcg',
    },
  }
}
