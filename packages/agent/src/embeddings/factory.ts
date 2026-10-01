import { KnowledgeEmbeddingSetting } from '@milibot/shared'

import { type ApiEmbeddingOptions, createApiEmbeddingProvider } from './api'
import { defaultEmbeddingSetting, findLocalEmbeddingLevel, type LocalEmbeddingLevel } from './catalog'
import { type LocalEmbeddingOptions, LocalEmbeddingProvider } from './local'
import { EmbeddingError, type EmbeddingProvider, type EmbeddingSetting } from './types'

/** Parses a stored `knowledge.embedding` value; anything invalid or unknown gives the default. */
export function parseEmbeddingSetting(value: unknown): EmbeddingSetting {
  const parsed = KnowledgeEmbeddingSetting.safeParse(value)
  if (!parsed.success) return defaultEmbeddingSetting()
  const setting = parsed.data
  if (setting.provider === 'local' && !findLocalEmbeddingLevel(setting.family, setting.level)) {
    return defaultEmbeddingSetting()
  }
  return setting
}

export interface EmbeddingProviderDeps {
  /** Local levels run in a worker process of this process. */
  local?: LocalEmbeddingOptions
  /** Local levels built elsewhere (the daemon's runtimes share the supervisor's model processes); wins over `local`. */
  createLocal?: (level: LocalEmbeddingLevel) => EmbeddingProvider
  /**
   * Connection details of an API setting: the daemon reads the `providers` row, its key from the
   * secret store and the model price (`ProviderStore.embeddingApiOptions`).
   */
  resolveApi?: (setting: Extract<EmbeddingSetting, { provider: 'api' }>) => Promise<ApiEmbeddingOptions>
}

/**
 * Provider of a `knowledge.embedding` setting. API models not in the catalog cost one tiny request
 * (output size detection). Call `dispose()` when switching settings so the local model can unload.
 */
export async function createEmbeddingProvider(
  setting: EmbeddingSetting,
  deps: EmbeddingProviderDeps,
  signal?: AbortSignal,
): Promise<EmbeddingProvider> {
  if (setting.provider === 'local') {
    const level = findLocalEmbeddingLevel(setting.family, setting.level)
    if (!level) {
      throw new EmbeddingError('invalid_setting', `unknown local model ${setting.family}/${setting.level}`)
    }
    if (deps.createLocal) return deps.createLocal(level)
    if (!deps.local) throw new EmbeddingError('invalid_setting', 'local embedding models are not available')
    return new LocalEmbeddingProvider(level, deps.local)
  }
  if (!deps.resolveApi)
    throw new EmbeddingError('invalid_setting', 'API embedding providers are not available')
  const options = await deps.resolveApi(setting)
  return createApiEmbeddingProvider(
    { ...options, ...(setting.dimensions ? { dimensions: setting.dimensions } : {}) },
    signal,
  )
}
