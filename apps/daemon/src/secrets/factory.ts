import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { HostInfo, LogFn } from '@milibot/shared'

import { EncryptedFileSecretStore } from './file-store'
import { KeychainSecretStore } from './keychain-store'
import { type KeyringEntryFactory, KeyringSecretStore } from './keyring-store'
import { MemorySecretStore, type SecretStore } from './secret-store'

export type SecretStoreKind = 'keychain' | 'keyring' | 'file' | 'memory'

/** What `GET /host` reports: which store holds the secrets and whether the interface must warn. */
export interface SecretStoreInfo {
  kind: SecretStoreKind
  /**
   * `keyring_unavailable`: Linux/Windows without a usable OS keyring, secrets in the encrypted file.
   * `keyring_unreachable`: the keyring this data folder uses did not answer; the secrets stay there.
   */
  warning: 'keyring_unavailable' | 'keyring_unreachable' | null
  /** Why the keyring was not usable (English, for logs and the details line). */
  detail: string | null
}

/** `GET /host` fields: the encrypted file is reported as `encrypted_file`. */
export function hostSecretStore(info: SecretStoreInfo): Pick<HostInfo, 'secretStore' | 'secretStoreWarning'> {
  return {
    secretStore: info.kind === 'file' ? 'encrypted_file' : info.kind,
    ...(info.warning === 'keyring_unreachable' ? { secretStoreWarning: info.warning } : {}),
  }
}

function secretsDir(dataRoot: string): string {
  return join(dataRoot, 'secrets')
}

/** Written once the keyring worked: from then on this data folder's secrets live there for good. */
function keyringMarker(dataRoot: string): string {
  return join(secretsDir(dataRoot), 'keyring-in-use')
}

function markKeyringInUse(dataRoot: string): void {
  try {
    mkdirSync(secretsDir(dataRoot), { recursive: true, mode: 0o700 })
    writeFileSync(keyringMarker(dataRoot), `${new Date().toISOString()}\n`, { mode: 0o600 })
  } catch {
    // Without the marker the next start just probes again.
  }
}

/** Default per platform: the Keychain on macOS, the OS keyring elsewhere. */
function defaultKind(platform: string): SecretStoreKind {
  return platform === 'darwin' ? 'keychain' : 'keyring'
}

/**
 * The store of an explicit kind (`MILIBOT_SECRET_STORE`, else the platform default), without probing.
 * Runtimes use it: the supervisor resolves the kind once (`resolveSecretStore`) and exports it to them.
 */
export function createSecretStore(options: {
  kind?: SecretStoreKind | null
  platform?: string
  dataRoot: string
  keyringEntry?: KeyringEntryFactory
}): SecretStore {
  const platform = options.platform ?? process.platform
  const kind = options.kind ?? defaultKind(platform)
  switch (kind) {
    case 'memory':
      return new MemorySecretStore()
    case 'keychain':
      return new KeychainSecretStore()
    case 'file':
      return new EncryptedFileSecretStore(secretsDir(options.dataRoot))
    case 'keyring':
      return new KeyringSecretStore(options.keyringEntry)
  }
}

/**
 * The supervisor's choice at startup. An explicit `MILIBOT_SECRET_STORE` wins. On Linux/Windows the
 * keyring is probed; without one the secrets go to the encrypted file with a warning (never silently),
 * and once a keyring answers again the file's secrets move into it. A data folder whose secrets already
 * went to the keyring stays on it even when the probe fails (locked at login, service not up yet): its
 * secrets fail until the keyring answers instead of looking missing.
 */
export async function resolveSecretStore(options: {
  dataRoot: string
  /** `MILIBOT_SECRET_STORE`. */
  explicit?: SecretStoreKind | null
  platform?: string
  keyringEntry?: KeyringEntryFactory
  probeTimeoutMs?: number
  log?: LogFn
}): Promise<{ store: SecretStore; info: SecretStoreInfo }> {
  const platform = options.platform ?? process.platform
  const kind = options.explicit ?? defaultKind(platform)
  const base = { dataRoot: options.dataRoot, platform, keyringEntry: options.keyringEntry }
  const fileWarning = (detail: string | null): SecretStoreInfo => ({
    kind: 'file',
    warning: 'keyring_unavailable',
    detail,
  })
  if (kind !== 'keyring') {
    const store = createSecretStore({ ...base, kind })
    return { store, info: kind === 'file' ? fileWarning(null) : { kind, warning: null, detail: null } }
  }
  const keyring = new KeyringSecretStore(options.keyringEntry)
  const sticky = existsSync(keyringMarker(options.dataRoot))
  try {
    await keyring.probe(options.probeTimeoutMs, { readOnly: sticky })
  } catch (err) {
    const detail = (err as Error).message
    if (sticky) {
      options.log?.('warn', 'OS keyring not answering; secrets stay in it', { detail })
      return { store: keyring, info: { kind: 'keyring', warning: 'keyring_unreachable', detail } }
    }
    options.log?.('warn', 'OS keyring unavailable; secrets go to the encrypted file', { detail })
    return { store: new EncryptedFileSecretStore(secretsDir(options.dataRoot)), info: fileWarning(detail) }
  }
  if (!sticky) markKeyringInUse(options.dataRoot)
  await migrateFileSecrets(new EncryptedFileSecretStore(secretsDir(options.dataRoot)), keyring, options.log)
  return { store: keyring, info: { kind: 'keyring', warning: null, detail: null } }
}

async function migrateFileSecrets(
  file: EncryptedFileSecretStore,
  keyring: SecretStore,
  log?: LogFn,
): Promise<void> {
  for (const workspaceId of file.workspaces()) {
    try {
      for (const key of await file.list(workspaceId)) {
        const value = await file.get(workspaceId, key)
        if (value !== null) await keyring.set(workspaceId, key, value)
      }
      await file.deleteNamespace(workspaceId)
      log?.('info', 'moved secrets from the encrypted file into the OS keyring', { workspaceId })
    } catch (err) {
      log?.('warn', 'could not move file secrets into the keyring', {
        workspaceId,
        err: (err as Error).message,
      })
    }
  }
}
