import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { CliError, type Flags, intFlag, stringFlag } from '../../lib/args.ts'
import type { VmCliCreateResult, VmConfigFile } from '../../lib/shared.ts'
import { writeConfig } from '../config.ts'
import type { VmHostContext } from '../context.ts'
import { copyVarsTemplate, firmware } from '../firmware.ts'
import { goldenVersion, resolveGolden } from '../golden.ts'
import { vmPaths } from '../paths.ts'
import { maxPortBase, MIN_PORT_BASE, portsOf } from '../ports.ts'
import { qemuImg } from '../qemu-img.ts'
import { writeSeed } from '../seed.ts'

export function sanitizeName(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return s || 'workspace'
}

export async function cmdCreate(ctx: VmHostContext, wsDir: string, flags: Flags): Promise<VmCliCreateResult> {
  const p = vmPaths(wsDir)
  if (fs.existsSync(p.config)) throw new CliError('VM_EXISTS', `VM already exists at ${p.vm}`)
  const cpus = intFlag(flags, 'cpus', { fallback: 4, max: 64 })
  const memGb = intFlag(flags, 'mem-gb', { fallback: 8, max: 512 })
  const dataGb = intFlag(flags, 'data-gb', { fallback: 60, min: 5, max: 4096 })
  const systemGb = intFlag(flags, 'system-gb', { fallback: 40, min: 20, max: 4096 })
  const portBase = intFlag(flags, 'port-base', { min: MIN_PORT_BASE, max: maxPortBase() })
  const golden = resolveGolden(ctx, stringFlag(flags, 'golden'))
  const name = sanitizeName(stringFlag(flags, 'name') ?? path.basename(path.resolve(wsDir)))
  const fw = firmware(ctx)

  fs.mkdirSync(p.vm, { recursive: true, mode: 0o700 })
  const config: VmConfigFile = {
    version: 1,
    name,
    hostname: `milibot-${name}`,
    instanceId: `milibot-${name}-${randomBytes(4).toString('hex')}`,
    cpus,
    memGb,
    systemGb,
    dataGb,
    portBase,
    golden,
    goldenVersion: goldenVersion(golden),
    macAddress: `52:54:00:${[0, 0, 0].map(() => randomBytes(1).toString('hex')).join(':')}`,
    createdAt: new Date().toISOString(),
    firmware: { ...fw.pair, codeSize: fw.codeSize },
  }
  const token = randomBytes(32).toString('hex')
  try {
    fs.writeFileSync(p.token, token + '\n', { mode: 0o600 })
    await qemuImg(ctx, 'create', '-q', '-f', 'qcow2', '-F', 'qcow2', '-b', golden, p.system, `${systemGb}G`)
    await qemuImg(ctx, 'create', '-q', '-f', 'qcow2', '-o', 'cluster_size=65536', p.data, `${dataGb}G`)
    copyVarsTemplate(fw.pair.vars, p.vars)
    writeSeed(p, config, token)
    writeConfig(p, config)
  } catch (err) {
    for (const f of [p.system, p.data, p.vars, p.seed, p.token]) fs.rmSync(f, { force: true })
    throw err
  }
  return { ok: true, created: true, vmDir: p.vm, config, ports: portsOf(config), tokenFile: p.token }
}
