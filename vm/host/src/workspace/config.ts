import fs from 'node:fs'

import { CliError } from '../lib/args.ts'
import { writeAtomic } from '../lib/host.ts'
import type { VmConfigFile } from '../lib/shared.ts'
import type { VmPaths } from './paths.ts'

export function readConfig(p: VmPaths): VmConfigFile {
  if (!fs.existsSync(p.config)) throw new CliError('NOT_FOUND', `no VM config at ${p.config}`)
  try {
    return JSON.parse(fs.readFileSync(p.config, 'utf8')) as VmConfigFile
  } catch (err) {
    throw new CliError('CONFIG_INVALID', `unreadable VM config at ${p.config}: ${(err as Error).message}`)
  }
}

export function writeConfig(p: VmPaths, config: VmConfigFile): void {
  writeAtomic(p.config, JSON.stringify(config, null, 2) + '\n')
}

export function clearRunning(p: VmPaths): void {
  if (!fs.existsSync(p.config)) return
  const config = readConfig(p)
  if (!config.running) return
  delete config.running
  writeConfig(p, config)
}
