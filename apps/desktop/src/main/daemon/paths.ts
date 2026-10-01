import { homedir } from 'node:os'

import { dataLayout, resolveDataRoot } from '@milibot/shared'

/** Same resolution as the daemon: `MILIBOT_DATA_DIR`, else the platform default (XDG on Linux). */
export function dataRoot(): string {
  return resolveDataRoot({
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    homedir: homedir(),
  })
}

export function appPaths() {
  return dataLayout(dataRoot(), process.platform)
}
