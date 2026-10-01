import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Whether the module at `metaUrl` is the script Node was started with (through symlinks and junctions too). */
export function isEntryPoint(metaUrl: string): boolean {
  if (!process.argv[1]) return false
  try {
    return fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(metaUrl))
  } catch {
    return false
  }
}
