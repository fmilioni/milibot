import { describe, expect, it } from 'vitest'

import { createSecretStore, hostSecretStore, resolveSecretStore } from '../../src/secrets/factory'
import { EncryptedFileSecretStore } from '../../src/secrets/file-store'
import {
  decodeSecretValue,
  encodeSecretValue,
  keychainAddCommand,
  keychainEntryUnits,
  KeychainSecretStore,
} from '../../src/secrets/keychain-store'
import {
  type KeyringEntryFactory,
  KeyringSecretStore,
  WINDOWS_CHUNK_UNITS,
} from '../../src/secrets/keyring-store'
import { MemorySecretStore, secretServiceName, splitSecret } from '../../src/secrets/secret-store'

describe('secret value encoding', () => {
  it('stores printable ASCII as-is and round-trips everything else', () => {
    for (const value of ['sk-or-v1-abc', 'deadbeef', ' spaced ', 'multi\nline', 'café', 'b64:literal', '']) {
      expect(decodeSecretValue(encodeSecretValue(value))).toBe(value)
    }
    expect(encodeSecretValue('deadbeef')).toBe('deadbeef')
    expect(encodeSecretValue('multi\nline').startsWith('b64:')).toBe(true)
  })

  it('namespaces services per workspace', () => {
    expect(secretServiceName('ws_1', 'provider/prv_1/api_key')).toBe('milibot/ws_1/provider/prv_1/api_key')
  })
})

describe('Keychain entries', () => {
  it('keeps every part of a long value within one security -i line', () => {
    const service = secretServiceName('ws_01JZ0000000000000000000000', `mcp/${'s'.repeat(200)}/oauth#99`)
    const values = [
      JSON.stringify({ access: 'x'.repeat(6000), refresh: 'y'.repeat(3000) }),
      'café🔑漢字'.repeat(900),
      'b64:' + 'z'.repeat(5000),
      'z'.repeat(5000) + 'b64:',
    ]
    for (const value of values) {
      const parts = splitSecret(value, keychainEntryUnits(value))
      expect(parts.length).toBeGreaterThan(1)
      for (const part of parts) expect(keychainAddCommand(service, part)).not.toBeNull()
    }
    expect(keychainAddCommand(service, 'x'.repeat(5000))).toBeNull()
  })
})

describe('MemorySecretStore', () => {
  it('isolates namespaces', async () => {
    const store = new MemorySecretStore()
    await store.set('ws_a', 'key', 'A')
    await store.set('ws_b', 'key', 'B')
    expect(await store.get('ws_a', 'key')).toBe('A')
    expect(await store.list('ws_b')).toEqual(['key'])
    await store.deleteNamespace('ws_a')
    expect(await store.get('ws_a', 'key')).toBeNull()
    expect(await store.get('ws_b', 'key')).toBe('B')
  })
})

/** `maxBytes`: like Windows Credential Manager, refuses passwords whose UTF-16 form is larger. */
const fakeKeyring = (fail = false, maxBytes = Infinity) => {
  const items = new Map<string, string>()
  const factory: KeyringEntryFactory = async (service, account) => ({
    getPassword: async () => {
      if (fail) throw new Error('no Secret Service')
      return items.get(`${service}|${account}`)
    },
    setPassword: async (password) => {
      if (fail) throw new Error('no Secret Service')
      if (Buffer.byteLength(password, 'utf16le') > maxBytes) throw new Error('TooLong')
      items.set(`${service}|${account}`, password)
    },
    deletePassword: async () => items.delete(`${service}|${account}`),
  })
  return { items, factory }
}

describe('KeyringSecretStore', () => {
  it('stores per workspace under milibot/<ws>/<key> with an index', async () => {
    const { items, factory } = fakeKeyring()
    const store = new KeyringSecretStore(factory)
    await store.set('ws_a', 'provider/p1/api_key', 'sk-café\nx')
    await store.set('ws_a', 'github', 'ghp')
    await store.set('ws_b', 'github', 'other')
    expect(await store.get('ws_a', 'provider/p1/api_key')).toBe('sk-café\nx')
    expect(await store.list('ws_a')).toEqual(['github', 'provider/p1/api_key'])
    expect(items.has('milibot/ws_a/github|milibot')).toBe(true)
    await store.delete('ws_a', 'github')
    expect(await store.list('ws_a')).toEqual(['provider/p1/api_key'])
    await store.deleteNamespace('ws_a')
    expect(await store.get('ws_a', 'provider/p1/api_key')).toBeNull()
    expect([...items.keys()].filter((k) => k.startsWith('milibot/ws_a/'))).toEqual([])
    expect(await store.get('ws_b', 'github')).toBe('other')
  })

  it('splits values over the Windows Credential Manager limit and reads both formats back', async () => {
    const { items, factory } = fakeKeyring(false, 2560)
    const store = new KeyringSecretStore(factory, { chunkUnits: WINDOWS_CHUNK_UNITS })
    const big = JSON.stringify({ access: 'x'.repeat(6000), refresh: 'café🔑'.repeat(500) })
    await store.set('ws', 'mcp/oauth', big)
    expect(await store.get('ws', 'mcp/oauth')).toBe(big)
    expect(items.get('milibot/ws/mcp/oauth|milibot')).toMatch(/^milibot-chunks:\d+$/)
    expect(items.has('milibot/ws/mcp/oauth#0|milibot')).toBe(true)

    // A shorter value replaces the parts, and leaves none behind.
    await store.set('ws', 'mcp/oauth', 'short')
    expect(await store.get('ws', 'mcp/oauth')).toBe('short')
    expect([...items.keys()].filter((k) => k.includes('#'))).toEqual([])

    // Values written whole (e.g. from another platform) read as they are.
    items.set('milibot/ws/plain|milibot', 'whole')
    expect(await store.get('ws', 'plain')).toBe('whole')

    // A value that looks like a header is never mistaken for one.
    await store.set('ws', 'tricky', 'milibot-chunks:2')
    expect(await store.get('ws', 'tricky')).toBe('milibot-chunks:2')

    await store.set('ws', 'mcp/oauth', big)
    await store.deleteNamespace('ws')
    expect([...items.keys()]).toEqual(['milibot/ws/plain|milibot'])
  })

  it('keeps an index longer than one entry on Windows', async () => {
    const { factory } = fakeKeyring(false, 2560)
    const store = new KeyringSecretStore(factory, { chunkUnits: WINDOWS_CHUNK_UNITS })
    const keys = Array.from({ length: 80 }, (_, i) => `provider/prv_${String(i).padStart(26, '0')}/api_key`)
    for (const key of keys) await store.set('ws', key, 'sk')
    expect(await store.list('ws')).toEqual([...keys].sort())
  })

  it('splits without breaking surrogate pairs', () => {
    const value = 'a' + '🔑'.repeat(5)
    const parts = splitSecret(value, 4)
    expect(parts.join('')).toBe(value)
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(4)
      expect(part).toBe(Buffer.from(part, 'utf8').toString('utf8'))
      expect(part).not.toMatch(/[\uD800-\uDBFF]$/)
    }
  })

  it('reports keyring failures instead of hiding them', async () => {
    const store = new KeyringSecretStore(fakeKeyring(true).factory)
    await expect(store.get('ws', 'k')).rejects.toThrow(/keyring read failed: no Secret Service/)
    await expect(store.probe()).rejects.toThrow()
  })
})

describe('secret store choice', () => {
  const dataRoot = '/nonexistent/milibot-secrets-test'

  it('keeps the Keychain on macOS and honors MILIBOT_SECRET_STORE', async () => {
    const mac = await resolveSecretStore({ dataRoot, platform: 'darwin' })
    expect(mac.info).toEqual({ kind: 'keychain', warning: null, detail: null })
    expect(mac.store).toBeInstanceOf(KeychainSecretStore)
    const memory = await resolveSecretStore({
      dataRoot,
      explicit: 'memory',
      platform: 'linux',
    })
    expect(memory.store).toBeInstanceOf(MemorySecretStore)
    expect(createSecretStore({ dataRoot, kind: 'file', platform: 'linux' })).toBeInstanceOf(
      EncryptedFileSecretStore,
    )
    expect(createSecretStore({ dataRoot, kind: undefined, platform: 'win32' })).toBeInstanceOf(
      KeyringSecretStore,
    )
  })

  it('uses the keyring when it answers, else the encrypted file with a warning', async () => {
    const ok = await resolveSecretStore({
      dataRoot,
      explicit: null,
      platform: 'linux',
      keyringEntry: fakeKeyring().factory,
    })
    expect(ok.info).toEqual({ kind: 'keyring', warning: null, detail: null })
    expect(ok.store).toBeInstanceOf(KeyringSecretStore)

    const logs: string[] = []
    const down = await resolveSecretStore({
      dataRoot,
      explicit: null,
      platform: 'linux',
      keyringEntry: fakeKeyring(true).factory,
      log: (level, message) => logs.push(`${level}: ${message}`),
    })
    expect(down.info).toMatchObject({
      kind: 'file',
      warning: 'keyring_unavailable',
      detail: 'no Secret Service',
    })
    expect(down.store).toBeInstanceOf(EncryptedFileSecretStore)
    expect(hostSecretStore(down.info)).toEqual({ secretStore: 'encrypted_file' })
    expect(hostSecretStore(ok.info)).toEqual({ secretStore: 'keyring' })
    expect(hostSecretStore({ kind: 'keyring', warning: 'keyring_unreachable', detail: 'locked' })).toEqual({
      secretStore: 'keyring',
      secretStoreWarning: 'keyring_unreachable',
    })
    expect(logs[0]).toMatch(/^warn: OS keyring unavailable/)
  })
})
