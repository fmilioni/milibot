import { accessSync, constants } from 'node:fs'

import { executableCandidates, type Host } from '@milibot/shared'

function isExecutable(file: string, platform: string): boolean {
  try {
    // Windows has no execute bit: existence is what counts.
    accessSync(file, platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * First `name` on PATH plus the platform's usual tool dirs (Homebrew on macOS, `/usr/bin` on Linux,
 * `Program Files\qemu` on Windows), with `.exe` added on Windows.
 */
export function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  host: Pick<Host, 'platform' | 'env'> = { platform: process.platform, env },
  isFile: (file: string, platform: string) => boolean = isExecutable,
): string | null {
  for (const candidate of executableCandidates(name, { platform: host.platform, env })) {
    if (isFile(candidate, host.platform)) return candidate
  }
  return null
}
