// Installs the pinned host programs the VM scripts need (gvproxy, QEMU) into vm/bin for this host.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isEntryPoint } from '../lib/entry.ts'
import { vmRootDir } from '../lib/vm-root.ts'
import { HostToolsError, installHostTools } from '../tools/host-tools.ts'

if (isEntryPoint(import.meta.url)) {
  try {
    await installHostTools({
      platform: process.platform,
      arch: process.arch,
      dest: path.join(vmRootDir(fileURLToPath(import.meta.url)), 'bin'),
      log: (message) => process.stderr.write(`vm:tools: ${message}\n`),
    })
  } catch (err) {
    if (!(err instanceof HostToolsError)) throw err
    process.stderr.write(`vm:tools: ${err.message}\n`)
    process.exitCode = 1
  }
}
