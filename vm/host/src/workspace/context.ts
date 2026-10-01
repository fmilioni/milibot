import os from 'node:os'
import path from 'node:path'

import { type HostProfile, hostProfiles } from '../lib/host.ts'
import { defaultDataRoot, type Host } from '../lib/shared.ts'

/** The host a command runs on and where golden images live. */
export interface VmHostContext {
  host: Host
  imagesDir: string
  profile: HostProfile
}

/** `MILIBOT_VM_ARCH=x64|arm64` emulates another guest architecture (TCG; for testing the command line only). */
export function vmHostContext(env: NodeJS.ProcessEnv = process.env): VmHostContext {
  const host: Host = {
    platform: process.platform,
    arch: env.MILIBOT_VM_ARCH || process.arch,
    env,
    homedir: os.homedir(),
  }
  const home = env.MILIBOT_HOME || env.MILIBOT_DATA_DIR || defaultDataRoot(host)
  return { host, imagesDir: path.join(home, 'images'), profile: hostProfiles(host) }
}
