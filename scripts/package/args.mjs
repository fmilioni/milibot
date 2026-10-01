import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const USAGE = `Usage: pnpm package [--dir] [--target win32-x64]

Builds and packages Milibot into dist/ for this OS and architecture.
  --dir                 the unpacked app only
  --target win32-x64    cross-build for Windows (the installer needs wine; --dir works without it)
Signing is opt-in through electron-builder's env vars (CSC_*, WIN_CSC_*, APPLE_*).
MILIBOT_PACKAGE_TARGET replaces --target, MILIBOT_PACKAGE_NODE the bundled Node,
MILIBOT_PACKAGE_INSPECT=1 keeps --inspect working (verification builds only).`

/** Reported by the entry point as `package: <message>` with exit code 1. */
export class PackageError extends Error {}

const TARGETS = { darwin: ['arm64'], linux: ['x64', 'arm64'], win32: ['x64'] }

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Where the package is built from and into. */
export function packagePaths() {
  const distDir = join(root, 'dist')
  return {
    root,
    desktop: join(root, 'apps/desktop'),
    daemon: join(root, 'apps/daemon'),
    distDir,
    stage: join(distDir, '.stage'),
    cache: join(distDir, '.cache'),
  }
}

/** The package's platform/architecture (the host's unless `--target` or `MILIBOT_PACKAGE_TARGET`). */
export function parseArgs(argv, env, host = { platform: process.platform, arch: process.arch }) {
  const targetArg = argv.find((arg, i) => argv[i - 1] === '--target') ?? env.MILIBOT_PACKAGE_TARGET
  const [platform = host.platform, arch = host.arch] = targetArg ? targetArg.split('-') : []
  return {
    help: argv.includes('--help') || argv.includes('-h'),
    dirOnly: argv.includes('--dir'),
    platform,
    arch,
    cross: platform !== host.platform || arch !== host.arch,
  }
}

export function hasWine() {
  return spawnSync('wine', ['--version'], { stdio: 'ignore', windowsHide: true }).status === 0
}

/** Throws when this host cannot build the requested package. */
export function checkTarget({ platform, arch, cross, dirOnly }, wine = hasWine) {
  if (!TARGETS[platform]?.includes(arch))
    throw new PackageError(`packaging for ${platform}-${arch} is not supported`)
  if (cross && platform !== 'win32')
    throw new PackageError(`cross-packaging only supports --target win32-x64 (not ${platform}-${arch})`)
  // electron-builder runs the first NSIS build under wine to extract the uninstaller.
  if (cross && !dirOnly && !wine())
    throw new PackageError(
      'the NSIS installer needs wine (x86) on this host: cross-build with --dir, or build on Windows',
    )
}
