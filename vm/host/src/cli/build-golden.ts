// Builds the Milibot golden image (Debian 13 + XFCE + dev toolchain + guest agent) for this host's
// architecture. The manifest JSON goes to stdout; progress lines to stderr.
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildGolden, type BuildOptions } from '../golden/build.ts'
import { BuildError, log } from '../golden/log.ts'
import { allowFlags, CliError, intFlag, parseArgs } from '../lib/args.ts'
import { isEntryPoint } from '../lib/entry.ts'
import { gvproxyBinary } from '../lib/gvproxy.ts'
import { hostProfiles } from '../lib/host.ts'
import {
  bundledQemuHome,
  defaultDataRoot,
  type Host,
  parseWhpxKernelIrqchip,
  searchPath,
  WHPX_KERNEL_IRQCHIP_ENV,
} from '../lib/shared.ts'
import { vmRootDir } from '../lib/vm-root.ts'

export const HELP = `usage: node vm/host/src/cli/build-golden.ts [--rebuild] [--cpus N] [--mem-gb N] [--timeout-min N] [--keep-work]
  (no flags)      build only if no golden image exists yet for this architecture
  --rebuild       build a new golden version (existing workspaces keep their old backing file)
  --timeout-min   default 90; x4 without hardware acceleration
env: MILIBOT_HOME (data folder), MILIBOT_QEMU_HOME / MILIBOT_GVPROXY (bundled QEMU / gvproxy; default vm/bin), MILIBOT_BUILD_DIR (scratch dir of the build disk; default <MILIBOT_HOME>/images/build)`

const FLAGS = ['rebuild', 'cpus', 'mem-gb', 'timeout-min', 'keep-work', 'help']

export function parseBuildOptions(argv: string[]): BuildOptions | 'help' {
  const { positional, flags } = parseArgs(argv)
  if (flags.help) return 'help'
  if (positional.length) throw new CliError('USAGE', `unknown argument: ${positional[0]}`, 2)
  allowFlags(flags, FLAGS)
  return {
    rebuild: flags.rebuild === true,
    cpus: intFlag(flags, 'cpus', { fallback: 8 }),
    memGb: intFlag(flags, 'mem-gb', { fallback: 8 }),
    timeoutMin: intFlag(flags, 'timeout-min', { fallback: 90 }),
    keepWork: flags['keep-work'] === true,
  }
}

async function main(argv: string[]): Promise<number> {
  let opts: BuildOptions | 'help'
  try {
    opts = parseBuildOptions(argv)
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n${HELP}\n`)
    return 2
  }
  if (opts === 'help') {
    process.stderr.write(HELP + '\n')
    return 0
  }
  const env = process.env
  const host: Host = { platform: process.platform, arch: process.arch, env, homedir: os.homedir() }
  const home = env.MILIBOT_HOME || env.MILIBOT_DATA_DIR || defaultDataRoot(host)
  const imagesDir = path.join(home, 'images')
  // One long unattended boot: a guest stuck on the hypervisor's APIC would only show as a timeout, so the
  // build keeps the conservative `off` unless MILIBOT_WHPX_KERNEL_IRQCHIP says otherwise.
  const forced = parseWhpxKernelIrqchip(env[WHPX_KERNEL_IRQCHIP_ENV])
  const irqchip = { mode: forced ?? 'off', forced: forced !== null }
  try {
    const vmDir = vmRootDir(fileURLToPath(import.meta.url))
    const manifest = await buildGolden(
      {
        host,
        vmDir,
        imagesDir,
        buildRoot: env.MILIBOT_BUILD_DIR || path.join(imagesDir, 'build'),
        baseUrl: env.MILIBOT_DEBIAN_BASE_URL || 'https://cloud.debian.org/images/cloud/trixie/latest',
        irqchip,
        profile: hostProfiles(host, bundledQemuHome(vmDir, host.platform, env), {
          whpxKernelIrqchip: irqchip.mode,
        }),
        gvproxy: gvproxyBinary(vmDir, env),
      },
      opts,
    )
    process.stdout.write(manifest)
    return 0
  } catch (err) {
    log(`ERROR: ${(err as Error)?.message ?? String(err)}`)
    if (!(err instanceof BuildError) && (err as Error)?.stack)
      process.stderr.write(`${(err as Error).stack}\n`)
    return 1
  }
}

if (isEntryPoint(import.meta.url)) {
  process.env.PATH = searchPath({ platform: process.platform, env: process.env })
  process.exit(await main(process.argv.slice(2)))
}
