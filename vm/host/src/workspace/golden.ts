import fs from 'node:fs'

import { CliError } from '../lib/args.ts'
import { goldenFs } from '../lib/host.ts'
import { parseGoldenFileName, resolveGoldenFile } from '../lib/shared.ts'
import type { VmHostContext } from './context.ts'

/** The image `images/current.json` names for this host's architecture. */
export function currentGolden(ctx: VmHostContext): string | null {
  return resolveGoldenFile(ctx.imagesDir, ctx.profile().goldenArch, goldenFs, ctx.host.platform)
}

export function resolveGolden(ctx: VmHostContext, explicit: string | undefined): string {
  const file = explicit ?? currentGolden(ctx)
  if (!file || !fs.existsSync(file)) {
    throw new CliError(
      'GOLDEN_NOT_FOUND',
      `golden image not found${file ? ` at ${file}` : ` in ${ctx.imagesDir}`} (build it first)`,
    )
  }
  return fs.realpathSync(file)
}

export function goldenVersion(golden: string): string | null {
  return parseGoldenFileName(golden)?.version ?? null
}
