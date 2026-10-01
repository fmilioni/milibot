import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { afterEach, beforeEach } from 'vitest'

import { MemorySecretStore } from '../../../../src/secrets/secret-store'
import { ZipWriter } from '../../../../src/util/zip'
import { bootRuntime, type BootRuntimeOptions, stopRuntimes } from '../../../support/runtime-harness'
import { useTempDir } from '../../../support/temp'

export const skillMd = (
  name: string,
  description = `Does ${name}. Load it for ${name} work.`,
  body = '# Steps\nDo it.',
) => `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`

export async function makeZip(path: string, entries: Record<string, string>) {
  const zip = await ZipWriter.create(path)
  for (const [name, content] of Object.entries(entries)) await zip.addBuffer(name, content, { deflate: true })
  await zip.finish()
}

export function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/** A temp dir and secret store per test, and a runtime without a VM booted by `start`. */
export function importRuntime() {
  const tempDir = useTempDir('import')
  const state = { dir: '', secrets: new MemorySecretStore() }
  beforeEach(() => {
    state.dir = tempDir()
    state.secrets = new MemorySecretStore()
  })
  afterEach(stopRuntimes)
  return {
    dir: () => state.dir,
    secrets: () => state.secrets,
    start: (overrides: BootRuntimeOptions['overrides'] = {}) =>
      bootRuntime({
        dir: state.dir,
        vm: false,
        secrets: state.secrets,
        script: () => ({ text: 'ok' }),
        overrides,
      }),
  }
}
