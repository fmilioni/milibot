import path from 'node:path'

import { goldenFs, writeAtomic } from '../lib/host.ts'
import { GOLDEN_POINTER_FILE, type GoldenArch, updatedGoldenPointer } from '../lib/shared.ts'

/** Points `images/current.json` at the new build. */
export function publishGolden(imagesDir: string, arch: GoldenArch, goldenName: string): void {
  const pointerFile = path.join(imagesDir, GOLDEN_POINTER_FILE)
  const previous = goldenFs.readFile(pointerFile)
  writeAtomic(pointerFile, JSON.stringify(updatedGoldenPointer(previous, arch, goldenName), null, 2) + '\n')
}
