import fs from 'node:fs'

import { writeAtomic } from '../lib/host.ts'
import { CLOUD_CONFIG_BASE } from '../lib/qemu.ts'
import { buildIso, type VmConfigFile } from '../lib/shared.ts'
import type { VmPaths } from './paths.ts'

/** cloud-init files of a workspace VM: hostname, the agent's bearer token and the workspace name. */
export function seedFiles(config: Pick<VmConfigFile, 'name' | 'hostname' | 'instanceId'>, token: string) {
  const workspaceInfo = JSON.stringify({ name: config.name, hostname: config.hostname })
  return {
    'meta-data': `instance-id: ${config.instanceId}\nlocal-hostname: ${config.hostname}\n`,
    'user-data': [
      '#cloud-config',
      `hostname: ${config.hostname}`,
      `fqdn: ${config.hostname}.local`,
      'preserve_hostname: false',
      'manage_etc_hosts: true',
      ...CLOUD_CONFIG_BASE,
      'write_files:',
      '  - path: /etc/milibot/agent.token',
      "    permissions: '0600'",
      '    owner: root:root',
      `    content: ${token}`,
      '  - path: /etc/milibot/workspace.json',
      "    permissions: '0644'",
      `    content: '${workspaceInfo.replaceAll("'", "''")}'`,
      '',
    ].join('\n'),
  }
}

export function writeSeed(p: VmPaths, config: VmConfigFile, token: string): void {
  const iso = buildIso(
    Object.entries(seedFiles(config, token)).map(([name, text]) => ({
      name,
      data: Buffer.from(text, 'utf8'),
    })),
    { volumeId: 'cidata' },
  )
  writeAtomic(p.seed, iso, 0o600)
  fs.chmodSync(p.seed, 0o600)
}
