import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import type { SecretStore } from './secret-store'

const KEY_FILE = 'local.key'
const SUFFIX = '.secrets'

interface Sealed {
  v: 1
  iv: string
  tag: string
  data: string
}

/**
 * Fallback when the OS keyring is unavailable (Linux session without GNOME Keyring/KWallet): one
 * AES-256-GCM file per workspace in `<dataRoot>/secrets/`, the key in `local.key` (0600, dir 0700).
 * It only protects against copies of the data folder without the key, not against the same user —
 * the interface warns about it (`keyring_unavailable`). Writes are atomic (tmp + rename) and re-read
 * the file first, since the supervisor and the workspace runtime both write.
 */
export class EncryptedFileSecretStore implements SecretStore {
  constructor(private readonly dir: string) {}

  async get(workspaceId: string, key: string): Promise<string | null> {
    return this.load(workspaceId)[key] ?? null
  }

  async set(workspaceId: string, key: string, value: string): Promise<void> {
    const values = this.load(workspaceId)
    values[key] = value
    this.save(workspaceId, values)
  }

  async delete(workspaceId: string, key: string): Promise<void> {
    const values = this.load(workspaceId)
    if (!(key in values)) return
    delete values[key]
    this.save(workspaceId, values)
  }

  async list(workspaceId: string): Promise<string[]> {
    return Object.keys(this.load(workspaceId)).sort()
  }

  async deleteNamespace(workspaceId: string): Promise<void> {
    rmSync(this.file(workspaceId), { force: true })
  }

  /** Workspaces with a secrets file (for the migration into a keyring that became available). */
  workspaces(): string[] {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir)
      .filter((name) => name.endsWith(SUFFIX))
      .map((name) => decodeURIComponent(name.slice(0, -SUFFIX.length)))
  }

  private file(workspaceId: string): string {
    return join(this.dir, `${encodeURIComponent(workspaceId)}${SUFFIX}`)
  }

  private key(): Buffer {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const file = join(this.dir, KEY_FILE)
    try {
      const key = readFileSync(file)
      if (key.length === 32) return key
    } catch {
      // Created below.
    }
    const key = randomBytes(32)
    // `wx`: two processes creating it at once keep the first one's key.
    try {
      writeFileSync(file, key, { mode: 0o600, flag: 'wx' })
    } catch {
      return readFileSync(file)
    }
    chmodSync(file, 0o600)
    return key
  }

  private load(workspaceId: string): Record<string, string> {
    let sealed: Sealed
    try {
      sealed = JSON.parse(readFileSync(this.file(workspaceId), 'utf8')) as Sealed
    } catch {
      return {}
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(sealed.iv, 'base64'))
    decipher.setAAD(Buffer.from(workspaceId))
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
    const plain = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()])
    const parsed = JSON.parse(plain.toString('utf8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  }

  private save(workspaceId: string, values: Record<string, string>): void {
    const key = this.key()
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(workspaceId))
    const data = Buffer.concat([cipher.update(JSON.stringify(values), 'utf8'), cipher.final()])
    const sealed: Sealed = {
      v: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    }
    const file = this.file(workspaceId)
    const tmp = `${file}.${process.pid}.${createHash('sha1').update(iv).digest('hex').slice(0, 6)}.tmp`
    writeFileSync(tmp, JSON.stringify(sealed), { mode: 0o600 })
    renameSync(tmp, file)
  }
}
