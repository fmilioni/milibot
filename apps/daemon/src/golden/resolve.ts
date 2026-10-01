import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { type Host, resolveGoldenFile } from '@milibot/shared'
import { goldenFs } from '@milibot/vm-host'

import { currentHost, hostVmProfile } from '../host/profile'

/** Golden image of this host's architecture in an `images/` dir (its `current.json` entry). */
function goldenInImages(imagesDir: string, host: Host = currentHost()): string | null {
  return resolveGoldenFile(imagesDir, hostVmProfile(host).goldenArch, goldenFs, host.platform)
}

/**
 * Golden image lookup: `MILIBOT_GOLDEN_IMAGE` (only it, when set), else `<dataRoot>/images`, then the
 * default data root (so a scratch dev/test data root still boots from the image already built there).
 */
export function resolveGoldenImage(
  dataRoot: string,
  defaultDataRoot: string,
  forced: string | null,
  host: Host = currentHost(),
): string | null {
  if (forced) return existsSync(forced) ? forced : null
  for (const root of [dataRoot, defaultDataRoot]) {
    const found = goldenInImages(join(root, 'images'), host)
    if (found) return found
  }
  return null
}
