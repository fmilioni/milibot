import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveSecretStore } from '../../src/secrets/factory'
import { EncryptedFileSecretStore } from '../../src/secrets/file-store'
import { type KeyringEntryFactory, KeyringSecretStore } from '../../src/secrets/keyring-store'
import { removeDir, tempDir } from '../support/temp'

let root: string
beforeEach(() => {
  root = tempDir('secret-file')
})
afterEach(() => removeDir(root))

describe('EncryptedFileSecretStore', () => {
  it('round-trips encrypted values with a private key file', async () => {
    const dir = join(root, 'secrets')
    const store = new EncryptedFileSecretStore(dir)
    await store.set('ws_1', 'provider/p/api_key', 'sk-very-secret-café')
    await store.set('ws_1', 'github', 'ghp_123456')
    await store.set('ws/2', 'x', 'y')
    // A second instance (another process) reads the same files.
    const other = new EncryptedFileSecretStore(dir)
    expect(await other.get('ws_1', 'provider/p/api_key')).toBe('sk-very-secret-café')
    expect(await other.list('ws_1')).toEqual(['github', 'provider/p/api_key'])
    expect(other.workspaces().sort()).toEqual(['ws/2', 'ws_1'])

    for (const name of readdirSync(dir)) {
      expect(readFileSync(join(dir, name), 'latin1')).not.toContain('sk-very-secret')
      if (process.platform !== 'win32') expect(statSync(join(dir, name)).mode & 0o077).toBe(0)
    }
    if (process.platform !== 'win32') expect(statSync(dir).mode & 0o077).toBe(0)

    await store.delete('ws_1', 'github')
    expect(await store.list('ws_1')).toEqual(['provider/p/api_key'])
    await store.deleteNamespace('ws_1')
    expect(await store.get('ws_1', 'provider/p/api_key')).toBeNull()
  })

  it('refuses a tampered file instead of returning garbage', async () => {
    const dir = join(root, 'secrets')
    const store = new EncryptedFileSecretStore(dir)
    await store.set('ws', 'k', 'value')
    const file = join(dir, 'ws.secrets')
    const sealed = JSON.parse(readFileSync(file, 'utf8')) as { data: string }
    sealed.data = Buffer.from('tampered').toString('base64')
    writeFileSync(file, JSON.stringify(sealed))
    await expect(store.get('ws', 'k')).rejects.toThrow()
  })

  it('moves file secrets into a keyring that became available', async () => {
    await new EncryptedFileSecretStore(join(root, 'secrets')).set('ws', 'k', 'v')
    const items = new Map<string, string>()
    const factory: KeyringEntryFactory = async (service) => ({
      getPassword: async () => items.get(service),
      setPassword: async (password) => void items.set(service, password),
      deletePassword: async () => items.delete(service),
    })
    const { store, info } = await resolveSecretStore({
      dataRoot: root,
      explicit: null,
      platform: 'linux',
      keyringEntry: factory,
    })
    expect(info.kind).toBe('keyring')
    expect(await store.get('ws', 'k')).toBe('v')
    expect(new EncryptedFileSecretStore(join(root, 'secrets')).workspaces()).toEqual([])
  })

  it('stays on the keyring once used, even when a later probe fails', async () => {
    const items = new Map<string, string>()
    let down = false
    const factory: KeyringEntryFactory = async (service) => ({
      getPassword: async () => {
        if (down) throw new Error('keyring locked')
        return items.get(service)
      },
      setPassword: async (password) => {
        if (down) throw new Error('keyring locked')
        items.set(service, password)
      },
      deletePassword: async () => items.delete(service),
    })
    const first = await resolveSecretStore({
      dataRoot: root,
      explicit: null,
      platform: 'linux',
      keyringEntry: factory,
    })
    expect(first.info.kind).toBe('keyring')
    await first.store.set('ws', 'k', 'v')
    expect(existsSync(join(root, 'secrets', 'keyring-in-use'))).toBe(true)
    expect(new EncryptedFileSecretStore(join(root, 'secrets')).workspaces()).toEqual([])

    down = true
    const logs: string[] = []
    const second = await resolveSecretStore({
      dataRoot: root,
      explicit: null,
      platform: 'linux',
      keyringEntry: factory,
      log: (level, message) => logs.push(`${level}: ${message}`),
    })
    expect(second.store).toBeInstanceOf(KeyringSecretStore)
    expect(second.info).toEqual({ kind: 'keyring', warning: 'keyring_unreachable', detail: 'keyring locked' })
    expect(logs).toEqual(['warn: OS keyring not answering; secrets stay in it'])
    await expect(second.store.get('ws', 'k')).rejects.toThrow(/keyring locked/)

    down = false
    expect(await second.store.get('ws', 'k')).toBe('v')
  })

  it('probes a keyring already in use without writing to it', async () => {
    const items = new Map<string, string>()
    const writes: string[] = []
    const factory: KeyringEntryFactory = async (service) => ({
      getPassword: async () => items.get(service),
      setPassword: async (password) => {
        writes.push(service)
        items.set(service, password)
      },
      deletePassword: async () => items.delete(service),
    })
    await resolveSecretStore({ dataRoot: root, platform: 'linux', keyringEntry: factory })
    expect(writes).toHaveLength(1)
    await resolveSecretStore({ dataRoot: root, platform: 'linux', keyringEntry: factory })
    expect(writes).toHaveLength(1)
  })
})
