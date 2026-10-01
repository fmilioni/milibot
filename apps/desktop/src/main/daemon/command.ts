import { posix, win32 } from 'node:path'

import { type HostPlatform, searchPath } from '@milibot/shared'

export interface DaemonCommand {
  /** Absolute path of the Node binary (an AppImage autostart entry: the AppImage). */
  command: string
  args: string[]
  /**
   * Variables the daemon needs on top of the caller's environment (data root, PATH with the
   * bundled Node and the QEMU folders, packaged VM scripts). A LaunchAgent can use them as-is.
   */
  env: Record<string, string>
  cwd?: string
}

type Env = Record<string, string | undefined>

/** The PATH key the environment already uses (Windows spells it `Path`), so the child gets one entry. */
export function pathKey(env: Env, platform: HostPlatform): string {
  return (
    Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? (platform === 'win32' ? 'Path' : 'PATH')
  )
}

/**
 * The packaged layout (`scripts/package/`), the same on every platform: the bundled Node
 * (`node/bin/node`, Windows `node\node.exe`), `daemon/main.js` and the VM scripts as Node files in
 * `vm/scripts`, run by the daemon's own Node.
 */
export function packagedDaemon(options: {
  platform: HostPlatform
  resourcesPath: string
  env: Env
}): DaemonCommand {
  const { platform, resourcesPath, env } = options
  const path = platform === 'win32' ? win32 : posix
  const nodeDir =
    platform === 'win32' ? path.join(resourcesPath, 'node') : path.join(resourcesPath, 'node', 'bin')
  const daemonDir = path.join(resourcesPath, 'daemon')
  const scripts = path.join(resourcesPath, 'vm', 'scripts')
  return {
    command: path.join(nodeDir, platform === 'win32' ? 'node.exe' : 'node'),
    args: [path.join(daemonDir, 'main.js')],
    env: {
      [pathKey(env, platform)]: searchPath({ platform, env }, [nodeDir]),
      MILIBOT_VM_CLI: env.MILIBOT_VM_CLI ?? path.join(scripts, 'workspace-vm.mjs'),
      MILIBOT_VM_BUILD: env.MILIBOT_VM_BUILD ?? path.join(scripts, 'build-golden.mjs'),
    },
    cwd: daemonDir,
  }
}

/** Set by the AppImage runtime; meaningless (or harmful) to the daemon, its runtimes and QEMU. */
const APPIMAGE_VARS = ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD']
const ORIGINAL_PREFIX = 'APPIMAGE_ORIGINAL_'

/**
 * The daemon's environment: the app's without Electron's variables (they would leak into the
 * daemon's Node and its forks) and without the AppImage's: its variables are dropped and
 * library paths pointing into the transient mount (`LD_LIBRARY_PATH`…) go back to what they were
 * before the AppImage started, so system QEMU never loads Electron's libraries.
 */
export function daemonEnvironment(parent: Env, extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined || key.startsWith('ELECTRON_') || key.startsWith(ORIGINAL_PREFIX)) continue
    if (APPIMAGE_VARS.includes(key)) continue
    out[key] = value
  }
  const appDir = parent.APPDIR
  if (appDir) {
    for (const [key, value] of Object.entries(parent)) {
      if (!key.startsWith(ORIGINAL_PREFIX)) continue
      const name = key.slice(ORIGINAL_PREFIX.length)
      if (value) out[name] = value
      else delete out[name]
    }
    const libraryPath = out.LD_LIBRARY_PATH
    if (libraryPath !== undefined && parent[`${ORIGINAL_PREFIX}LD_LIBRARY_PATH`] === undefined) {
      const kept = libraryPath.split(':').filter((dir) => dir && !dir.startsWith(appDir))
      if (kept.length > 0) out.LD_LIBRARY_PATH = kept.join(':')
      else delete out.LD_LIBRARY_PATH
    }
  }
  return { ...out, ...extra }
}
