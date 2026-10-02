import os from 'node:os'
import path from 'node:path'

import { gvproxyBinary } from '../lib/gvproxy.ts'
import { type HostProfile, hostProfiles } from '../lib/host.ts'
import { bundledQemuHome, defaultDataRoot, type Host } from '../lib/shared.ts'

/** The host a command runs on, where golden images live and the network helper it starts. */
export interface VmHostContext {
  host: Host
  imagesDir: string
  profile: HostProfile
  gvproxy: string
}

/**
 * `vmRoot` is the `vm/` folder (`vmRootDir`). `MILIBOT_VM_ARCH=x64|arm64` emulates another guest
 * architecture (TCG; for testing the command line only).
 */
export function vmHostContext(vmRoot: string, env: NodeJS.ProcessEnv = process.env): VmHostContext {
  const host: Host = {
    platform: process.platform,
    arch: env.MILIBOT_VM_ARCH || process.arch,
    env,
    homedir: os.homedir(),
  }
  const home = env.MILIBOT_HOME || env.MILIBOT_DATA_DIR || defaultDataRoot(host)
  return {
    host,
    imagesDir: path.join(home, 'images'),
    profile: hostProfiles(host, bundledQemuHome(vmRoot, host.platform, env)),
    gvproxy: gvproxyBinary(vmRoot, env),
  }
}
