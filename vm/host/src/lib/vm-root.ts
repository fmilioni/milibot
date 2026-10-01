import path from 'node:path'

/**
 * The `vm/` folder (guest-agent/, guest/, provision files, golden-revision) of a VM script:
 * `vm/host/src/cli/*.ts` from sources, `vm/scripts/*.mjs` in the packaged app, else the script's own folder
 * (`vm/*.sh` shortcuts, test fakes).
 */
export function vmRootDir(script: string): string {
  const dir = path.dirname(script)
  const parts = dir.split(/[\\/]/)
  if (parts.slice(-3).join('/') === 'host/src/cli') return path.resolve(dir, '..', '..', '..')
  if (parts.at(-1) === 'scripts') return path.dirname(dir)
  return dir
}
