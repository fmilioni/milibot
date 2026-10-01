import { z } from 'zod'

export const LocalEmbeddingFamily = z.enum(['embeddinggemma', 'multilingual-e5'])
export type LocalEmbeddingFamily = z.infer<typeof LocalEmbeddingFamily>

/** Model the knowledge base embeds with. */
export const KnowledgeEmbeddingSetting = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('local'),
    family: LocalEmbeddingFamily,
    level: z.string().min(1),
  }),
  z.object({
    provider: z.literal('api'),
    providerId: z.string().min(1),
    model: z.string().min(1),
    dimensions: z.number().int().positive().nullable().optional(),
  }),
])
export type KnowledgeEmbeddingSetting = z.infer<typeof KnowledgeEmbeddingSetting>

export const EmbeddingLevelOption = z.object({
  id: z.string(),
  dimensions: z.number().int(),
  maxInputTokens: z.number().int(),
  /** Measured peak memory while indexing. */
  ramMb: z.number().int(),
  downloadBytes: z.number().int(),
  recommended: z.boolean(),
  /** Every file of the model is in the shared model cache. */
  downloaded: z.boolean(),
  /** Bytes of the model already on disk. */
  diskBytes: z.number().int(),
  /** 0..1 while this model is being downloaded. */
  downloadProgress: z.number().nullable(),
  spaceKey: z.string(),
})
export type EmbeddingLevelOption = z.infer<typeof EmbeddingLevelOption>

export const EmbeddingFamilyOption = z.object({
  id: LocalEmbeddingFamily,
  name: z.string(),
  vendor: z.string(),
  levels: z.array(EmbeddingLevelOption),
})
export type EmbeddingFamilyOption = z.infer<typeof EmbeddingFamilyOption>

/** An enabled embedding model of a provider, with what the user saved for it. */
export const EmbeddingApiModelOption = z.object({
  model: z.string(),
  name: z.string(),
  /** Null until a test (or the first use) measures it. */
  dimensions: z.number().int().nullable(),
  maxInputTokens: z.number().int().nullable(),
  priceInputPerMtokUsd: z.number().nullable(),
})
export type EmbeddingApiModelOption = z.infer<typeof EmbeddingApiModelOption>

export const EmbeddingApiProviderOption = z.object({
  providerId: z.string(),
  name: z.string(),
  preset: z.string().nullable(),
  /** localhost: passages do not leave the host. */
  local: z.boolean(),
  /** Enabled embedding models of the provider (`provider_models.kind = 'embedding'`). */
  models: z.array(EmbeddingApiModelOption),
})
export type EmbeddingApiProviderOption = z.infer<typeof EmbeddingApiProviderOption>

export const ProbeEmbeddingModelBody = z.object({ providerId: z.string().min(1), model: z.string().min(1) })

export const EmbeddingOptions = z.object({
  current: KnowledgeEmbeddingSetting,
  local: z.array(EmbeddingFamilyOption),
  /** Every `openai_compatible` provider of the workspace (models may be empty). */
  api: z.array(EmbeddingApiProviderOption),
})
export type EmbeddingOptions = z.infer<typeof EmbeddingOptions>
