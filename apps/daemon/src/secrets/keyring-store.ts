import { ENTRY_ACCOUNT, IndexedEntrySecretStore } from './secret-store'

/** The part of `@napi-rs/keyring`'s `AsyncEntry` the store uses (injected in tests). */
interface KeyringEntry {
  getPassword(signal?: AbortSignal | null): Promise<string | undefined | null>
  setPassword(password: string, signal?: AbortSignal | null): Promise<void>
  deletePassword(signal?: AbortSignal | null): Promise<boolean>
}

export type KeyringEntryFactory = (service: string, account: string) => Promise<KeyringEntry>

/** A keyring that stopped answering (locked prompt, hung D-Bus) must not freeze requests forever. */
const OPERATION_TIMEOUT_MS = 15_000

/**
 * Windows Credential Manager rejects passwords over 2560 bytes, stored as UTF-16 (1280 code units): OAuth
 * records, private keys or a busy index are longer. Such values are split into `<service>#<n>` entries.
 */
export const WINDOWS_CHUNK_UNITS = 1200

/**
 * Loaded on first use so macOS (Keychain) never loads the native module. Linux is pinned to the Secret
 * Service: the library's automatic fallback is the kernel keyring (keyutils), which forgets everything on
 * logout/reboot — without a Secret Service the probe fails and the encrypted file is used instead.
 */
const napiKeyringEntry: KeyringEntryFactory = async (service, account) => {
  const { AsyncEntry } = await import('@napi-rs/keyring')
  return new AsyncEntry(service, account, { linux: { store: 'secret-service' } })
}

/**
 * OS credential store through `@napi-rs/keyring`: Secret Service (GNOME Keyring/KWallet via libsecret's
 * D-Bus API) on Linux, Credential Manager on Windows. Same layout as the Keychain store; values longer than
 * `chunkUnits` (Windows only by default) are split over several entries.
 */
export class KeyringSecretStore extends IndexedEntrySecretStore {
  private readonly chunkUnits: number | null

  constructor(
    private readonly entry: KeyringEntryFactory = napiKeyringEntry,
    options: { chunkUnits?: number | null } = {},
  ) {
    super()
    this.chunkUnits =
      options.chunkUnits !== undefined
        ? options.chunkUnits
        : process.platform === 'win32'
          ? WINDOWS_CHUNK_UNITS
          : null
  }

  /**
   * Throws when there is no usable keyring (no Secret Service, locked…): a round trip of a throwaway entry,
   * or with `readOnly` only a lookup of a missing one, which never asks to unlock the keyring.
   */
  async probe(timeoutMs = 5000, options: { readOnly?: boolean } = {}): Promise<void> {
    const service = `milibot/__probe/${process.pid}`
    const entry = await this.entry(service, ENTRY_ACCOUNT)
    const signal = AbortSignal.timeout(timeoutMs)
    if (options.readOnly) {
      await entry.getPassword(signal)
      return
    }
    await entry.setPassword('probe', signal)
    const back = await entry.getPassword(signal)
    await entry.deletePassword(signal).catch(() => false)
    if (back !== 'probe') throw new Error('keyring did not return the value it stored')
  }

  protected entryUnits(): number | null {
    return this.chunkUnits
  }

  protected async readEntry(service: string): Promise<string | null> {
    try {
      const entry = await this.entry(service, ENTRY_ACCOUNT)
      return (await entry.getPassword(AbortSignal.timeout(OPERATION_TIMEOUT_MS))) ?? null
    } catch (err) {
      throw new Error(`keyring read failed: ${(err as Error).message}`, { cause: err })
    }
  }

  protected async writeEntry(service: string, value: string): Promise<void> {
    try {
      const entry = await this.entry(service, ENTRY_ACCOUNT)
      await entry.setPassword(value, AbortSignal.timeout(OPERATION_TIMEOUT_MS))
    } catch (err) {
      throw new Error(`keyring write failed: ${(err as Error).message}`, { cause: err })
    }
  }

  protected async removeEntry(service: string): Promise<void> {
    try {
      const entry = await this.entry(service, ENTRY_ACCOUNT)
      await entry.deletePassword(AbortSignal.timeout(OPERATION_TIMEOUT_MS))
    } catch (err) {
      throw new Error(`keyring delete failed: ${(err as Error).message}`, { cause: err })
    }
  }
}
