/**
 * Secrets are namespaced per workspace: the entry's service is `milibot/<workspaceId>/<key>`.
 * Nothing secret is ever written to SQLite.
 */
export interface SecretStore {
  get(workspaceId: string, key: string): Promise<string | null>
  set(workspaceId: string, key: string, value: string): Promise<void>
  delete(workspaceId: string, key: string): Promise<void>
  list(workspaceId: string): Promise<string[]>
  deleteNamespace(workspaceId: string): Promise<void>
}

export function secretServiceName(workspaceId: string, key: string): string {
  return `milibot/${workspaceId}/${key}`
}

/** Key of a provider's API key. */
export const secretKeyFor = (providerId: string) => `provider.${providerId}.secret`

export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, Map<string, string>>()

  async get(workspaceId: string, key: string) {
    return this.values.get(workspaceId)?.get(key) ?? null
  }

  async set(workspaceId: string, key: string, value: string) {
    let namespace = this.values.get(workspaceId)
    if (!namespace) {
      namespace = new Map()
      this.values.set(workspaceId, namespace)
    }
    namespace.set(key, value)
  }

  async delete(workspaceId: string, key: string) {
    this.values.get(workspaceId)?.delete(key)
  }

  async list(workspaceId: string) {
    return [...(this.values.get(workspaceId)?.keys() ?? [])].sort()
  }

  async deleteNamespace(workspaceId: string) {
    this.values.delete(workspaceId)
  }
}

/** Account of every OS credential entry Milibot writes. */
export const ENTRY_ACCOUNT = 'milibot'
const INDEX_KEY = '__index'

/** Main entry of a split value: `milibot-chunks:<parts>`. */
const CHUNK_HEADER = 'milibot-chunks:'
const CHUNK_HEADER_RE = /^milibot-chunks:(\d+)$/
const HEADER_LOOKALIKE_UNITS = 1000

/** Parts of at most `maxUnits` UTF-16 code units, never splitting a surrogate pair. */
export function splitSecret(value: string, maxUnits: number): string[] {
  const parts: string[] = []
  let start = 0
  while (start < value.length) {
    let end = Math.min(start + maxUnits, value.length)
    const last = value.charCodeAt(end - 1)
    if (end < value.length && end - start > 1 && last >= 0xd800 && last <= 0xdbff) end--
    parts.push(value.slice(start, end))
    start = end
  }
  return parts
}

function chunkCount(stored: string | null): number {
  const match = stored === null ? null : CHUNK_HEADER_RE.exec(stored)
  return match ? Number(match[1]) : 0
}

/**
 * An OS credential store holding one entry per secret (service `milibot/<workspaceId>/<key>`, account
 * `milibot`) plus an `__index` entry listing each workspace's keys, since those stores can't list by
 * prefix. Values longer than one entry holds (`entryUnits`) are split into `<service>#<n>` entries under a
 * `milibot-chunks:<n>` header; split values are read back whatever the limit. Subclasses only read, write
 * and remove single entries.
 */
export abstract class IndexedEntrySecretStore implements SecretStore {
  protected abstract readEntry(service: string): Promise<string | null>
  protected abstract writeEntry(service: string, value: string): Promise<void>
  protected abstract removeEntry(service: string): Promise<void>
  /** Most UTF-16 code units one entry holds for this value, or null when there is no limit. */
  protected abstract entryUnits(value: string): number | null

  get(workspaceId: string, key: string): Promise<string | null> {
    return this.read(secretServiceName(workspaceId, key))
  }

  async set(workspaceId: string, key: string, value: string): Promise<void> {
    await this.write(secretServiceName(workspaceId, key), value)
    const keys = await this.list(workspaceId)
    if (!keys.includes(key)) await this.writeIndex(workspaceId, [...keys, key])
  }

  async delete(workspaceId: string, key: string): Promise<void> {
    await this.remove(secretServiceName(workspaceId, key))
    const keys = await this.list(workspaceId)
    if (keys.includes(key))
      await this.writeIndex(
        workspaceId,
        keys.filter((k) => k !== key),
      )
  }

  async list(workspaceId: string): Promise<string[]> {
    const raw = await this.read(secretServiceName(workspaceId, INDEX_KEY))
    if (raw === null) return []
    try {
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string').sort() : []
    } catch {
      return []
    }
  }

  async deleteNamespace(workspaceId: string): Promise<void> {
    for (const key of await this.list(workspaceId)) await this.remove(secretServiceName(workspaceId, key))
    await this.remove(secretServiceName(workspaceId, INDEX_KEY))
  }

  private async read(service: string): Promise<string | null> {
    const stored = await this.readEntry(service)
    const count = chunkCount(stored)
    if (count === 0) return stored
    const parts: string[] = []
    for (let i = 0; i < count; i++) {
      const part = await this.readEntry(`${service}#${i}`)
      if (part === null) throw new Error(`secret read failed: part ${i + 1} of ${count} is missing`)
      parts.push(part)
    }
    return parts.join('')
  }

  private async write(service: string, value: string): Promise<void> {
    const previous = chunkCount(await this.readEntry(service))
    const units = this.entryUnits(value)
    // A value that looks like a header is split too, so reading it back is never ambiguous.
    const split = (units !== null && value.length > units) || value.startsWith(CHUNK_HEADER)
    const parts = split ? splitSecret(value, units ?? HEADER_LOOKALIKE_UNITS) : []
    for (const [i, part] of parts.entries()) await this.writeEntry(`${service}#${i}`, part)
    await this.writeEntry(service, split ? `${CHUNK_HEADER}${parts.length}` : value)
    for (let i = parts.length; i < previous; i++) await this.removeEntry(`${service}#${i}`)
  }

  private async remove(service: string): Promise<void> {
    const count = chunkCount(await this.readEntry(service))
    await this.removeEntry(service)
    for (let i = 0; i < count; i++) await this.removeEntry(`${service}#${i}`)
  }

  private writeIndex(workspaceId: string, keys: string[]): Promise<void> {
    return this.write(secretServiceName(workspaceId, INDEX_KEY), JSON.stringify(keys))
  }
}
