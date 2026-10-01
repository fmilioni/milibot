import { z } from 'zod'

import { endpoint, Ok } from '../http/endpoint'
import { CLI_ENGINES, CliAuthMode } from './cli'
import { ReasoningEffort } from './reasoning'

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

/** An OpenRouter server: created from the preset, or any base URL at openrouter.ai. */
export function isOpenRouterServer(
  baseUrl: string | null | undefined,
  preset: string | null | undefined,
): boolean {
  return preset === 'openrouter' || (baseUrl ?? '').includes('openrouter.ai')
}

export const ProviderType = z.enum(['openai_compatible', 'anthropic', 'claude_code', 'codex'])
export type ProviderType = z.infer<typeof ProviderType>

/**
 * Reasoning field of an OpenAI-compatible server: `reasoning_effort` (OpenAI and most servers),
 * `openrouter` (`reasoning: {effort}`), `none` (never sent); `auto` picks from the preset, the URL and what
 * the server lists for the model.
 */
export const ReasoningParam = z.enum(['auto', 'reasoning_effort', 'openrouter', 'none'])
export type ReasoningParam = z.infer<typeof ReasoningParam>

/** Output cap field of an OpenAI-compatible server; `auto` = `max_completion_tokens` on api.openai.com. */
export const OutputCapField = z.enum(['auto', 'max_tokens', 'max_completion_tokens'])
export type OutputCapField = z.infer<typeof OutputCapField>

/**
 * Whether an OpenAI-compatible server's plain reasoning field (`reasoning` / `reasoning_content`, vLLM,
 * SGLang, llama.cpp) goes back on the assistant messages, so the model keeps its thinking across tool calls.
 * `auto` sends it back in the field it came in; `off` for a server that emits it but refuses it as input.
 */
export const ReasoningReplay = z.enum(['auto', 'off'])
export type ReasoningReplay = z.infer<typeof ReasoningReplay>

export const Provider = z.object({
  id: z.string(),
  type: ProviderType,
  name: z.string(),
  /** e.g. `openrouter` for an openai_compatible provider. */
  preset: z.string().nullable(),
  baseUrl: z.string().nullable(),
  extraHeaders: z.record(z.string(), z.string()),
  /** Cheap model for side work (triage, summaries) when the workspace picks none; null = the bot's own. */
  lightModel: z.string().nullable(),
  isDefault: z.boolean(),
  defaultModel: z.string().nullable(),
  /** An API key / auth token is in the secret store (the value is never exposed). */
  hasSecret: z.boolean(),
  authMode: CliAuthMode.nullable(),
  /** CLI engines only: minutes before an idle CLI process of a lane is stopped. */
  idleTimeoutMinutes: z.number().int().positive().nullable(),
  /** openai_compatible only (the next two as well). */
  reasoningParam: ReasoningParam.nullable(),
  outputCapField: OutputCapField.nullable(),
  reasoningReplay: ReasoningReplay.nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type Provider = z.infer<typeof Provider>

export const ProviderModelSource = z.enum(['fetched', 'manual', 'builtin'])
export type ProviderModelSource = z.infer<typeof ProviderModelSource>

/** `embedding` models feed the knowledge base; `image` models draw (`generate_image`). */
export const ProviderModelKind = z.enum(['chat', 'embedding', 'image'])
export type ProviderModelKind = z.infer<typeof ProviderModelKind>

export const ProviderModel = z.object({
  id: z.string(),
  providerId: z.string(),
  kind: ProviderModelKind,
  modelId: z.string(),
  displayName: z.string(),
  supportsTools: z.boolean(),
  /** A chat model reads images; an image model takes reference images. */
  supportsVision: z.boolean(),
  /** Context window of a chat model; longest input of an embedding model. Null = unknown. */
  contextWindow: z.number().int().positive().nullable(),
  /** Cap sent when the choice sets none. Null = the provider's default. */
  maxOutputTokens: z.number().int().positive().nullable(),
  /** null = unknown (sent as asked), [] = none. */
  efforts: z.array(ReasoningEffort).nullable(),
  /** Effort used when the choice sets none; null = the provider's own default. */
  defaultEffort: ReasoningEffort.nullable(),
  /** Of an embedding model, known after a test. */
  dimensions: z.number().int().positive().nullable(),
  /** Reasoning tokens bill as output; image tokens bill as input. */
  priceInputPerMtokUsd: z.number().nonnegative().nullable(),
  priceCacheReadPerMtokUsd: z.number().nonnegative().nullable(),
  priceCacheWritePerMtokUsd: z.number().nonnegative().nullable(),
  priceOutputPerMtokUsd: z.number().nonnegative().nullable(),
  /** Per request of a chat model; per picture of an image model. */
  pricePerRequestUsd: z.number().nonnegative().nullable(),
  enabled: z.boolean(),
  source: ProviderModelSource,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type ProviderModel = z.infer<typeof ProviderModel>

export const CreateProviderBody = z.object({
  type: ProviderType,
  name: z.string().trim().min(1).max(64),
  /** `openrouter` and `google` fill the base URL. */
  preset: z.string().nullable().optional(),
  baseUrl: z.string().url().nullable().optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  /** Kept in the secret store, never in SQLite; `null` clears it on update. */
  apiKey: z.string().min(1).nullable().optional(),
  authMode: CliAuthMode.optional(),
  defaultModel: z.string().nullable().optional(),
  lightModel: z.string().nullable().optional(),
  isDefault: z.boolean().optional(),
  idleTimeoutMinutes: z
    .number()
    .int()
    .positive()
    .max(24 * 60)
    .optional(),
  reasoningParam: ReasoningParam.optional(),
  outputCapField: OutputCapField.optional(),
  reasoningReplay: ReasoningReplay.optional(),
})
export type CreateProviderBody = z.input<typeof CreateProviderBody>

export const UpdateProviderBody = CreateProviderBody.omit({ type: true }).partial()
export type UpdateProviderBody = z.input<typeof UpdateProviderBody>

const Price = z.number().nonnegative().nullable()

export const CreateProviderModelBody = z.object({
  kind: ProviderModelKind.default('chat'),
  modelId: z.string().trim().min(1),
  displayName: z.string().trim().min(1).optional(),
  supportsTools: z.boolean().default(true),
  supportsVision: z.boolean().default(true),
  contextWindow: z.number().int().positive().nullable().optional(),
  maxOutputTokens: z.number().int().positive().nullable().optional(),
  efforts: z.array(ReasoningEffort).nullable().optional(),
  defaultEffort: ReasoningEffort.nullable().optional(),
  dimensions: z.number().int().positive().nullable().optional(),
  priceInputPerMtokUsd: Price.optional(),
  priceOutputPerMtokUsd: Price.optional(),
  priceCacheWritePerMtokUsd: Price.optional(),
  priceCacheReadPerMtokUsd: Price.optional(),
  pricePerRequestUsd: Price.optional(),
  enabled: z.boolean().default(true),
})
export type CreateProviderModelBody = z.input<typeof CreateProviderModelBody>

const UpdateProviderModelBody = CreateProviderModelBody.omit({ kind: true }).partial()

const ListProviderModelsQuery = z.object({ kind: ProviderModelKind.default('chat') })

const TestProviderBody = z.object({ model: z.string().optional() })

export const ConnectionTest = z.object({
  ok: z.boolean(),
  model: z.string().nullable(),
  supportsTools: z.boolean(),
  supportsVision: z.boolean(),
  latencyMs: z.number().int().nullable(),
  error: z.string().nullable(),
})
export type ConnectionTest = z.infer<typeof ConnectionTest>

/** An unsaved provider (or a saved one being edited: `providerId`). */
export const ProviderDraft = z.object({
  type: ProviderType.exclude(CLI_ENGINES),
  baseUrl: z.string().url().nullable().optional(),
  preset: z.string().nullable().optional(),
  /** Omitted with `providerId` = the stored key. */
  apiKey: z.string().nullable().optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  providerId: z.string().optional(),
})
export type ProviderDraft = z.infer<typeof ProviderDraft>

const TestProviderDraftBody = z.object({ draft: ProviderDraft, model: z.string().optional() })
const ProviderDraftModelsBody = z.object({ draft: ProviderDraft })

export const DraftModel = ProviderModel.pick({
  modelId: true,
  displayName: true,
  supportsTools: true,
  supportsVision: true,
  contextWindow: true,
  maxOutputTokens: true,
  efforts: true,
  defaultEffort: true,
  priceInputPerMtokUsd: true,
  priceOutputPerMtokUsd: true,
  priceCacheWritePerMtokUsd: true,
  priceCacheReadPerMtokUsd: true,
})
export type DraftModel = z.infer<typeof DraftModel>

/**
 * A model the server lists for the embedding table. OpenRouter says which models embed
 * (`output_modalities=embeddings`, with price and context); other servers only list ids, so
 * `embedding` is a guess from the id and the user decides.
 */
export const EmbeddingModelCandidate = z.object({
  modelId: z.string(),
  displayName: z.string(),
  description: z.string().nullable(),
  contextWindow: z.number().int().positive().nullable(),
  priceInputPerMtokUsd: z.number().nonnegative().nullable(),
  /** OpenRouter does not say it; a test finds it. */
  dimensions: z.number().int().positive().nullable(),
  /** The server says it embeds (OpenRouter) or the id looks like it (`embed`). */
  embedding: z.boolean(),
  /** Known to work well for the knowledge base (Qwen3 Embedding). */
  suggested: z.boolean(),
})
export type EmbeddingModelCandidate = z.infer<typeof EmbeddingModelCandidate>

export const EmbeddingModelCandidates = z.object({
  models: z.array(EmbeddingModelCandidate),
  /** The server lists only embedding models (OpenRouter), so every candidate is one. */
  verified: z.boolean(),
})
export type EmbeddingModelCandidates = z.infer<typeof EmbeddingModelCandidates>

export const EmbeddingProbeErrorCode = z.enum([
  'unauthorized',
  'model_not_found',
  'not_embedding',
  'unreachable',
  'invalid_response',
  'provider_error',
])
export type EmbeddingProbeErrorCode = z.infer<typeof EmbeddingProbeErrorCode>

/** One `POST /embeddings` with a short text: the model works and its vector size. */
export const EmbeddingProbeResult = z.object({
  ok: z.boolean(),
  dimensions: z.number().int().positive().nullable(),
  errorCode: EmbeddingProbeErrorCode.nullable(),
  error: z.string().nullable(),
})
export type EmbeddingProbeResult = z.infer<typeof EmbeddingProbeResult>

/**
 * A model the server lists for the image table. OpenRouter and Google say which models draw; other servers
 * only list ids, so `image` is a guess from the id and the user decides.
 */
export const ImageModelCandidate = z.object({
  modelId: z.string(),
  displayName: z.string(),
  description: z.string().nullable(),
  pricePerImageUsd: z.number().nonnegative().nullable(),
  supportsVision: z.boolean(),
  image: z.boolean(),
})
export type ImageModelCandidate = z.infer<typeof ImageModelCandidate>

export const ImageModelCandidates = z.object({
  models: z.array(ImageModelCandidate),
  /** The server lists only image models, so every candidate is one. */
  verified: z.boolean(),
})
export type ImageModelCandidates = z.infer<typeof ImageModelCandidates>

const ProviderDraftEmbeddingProbeBody = z.object({ draft: ProviderDraft, model: z.string().min(1) })

/** OpenRouter's `/credits` and `/key`. */
export const ProviderAccount = z.object({
  supported: z.boolean(),
  creditUsd: z.number().nullable(),
  usageUsd: z.number().nullable(),
  limitUsd: z.number().nullable(),
  error: z.string().nullable(),
})
export type ProviderAccount = z.infer<typeof ProviderAccount>

export const providerEndpoints = {
  listProviders: endpoint({ method: 'GET', path: '/w/:workspaceId/providers', response: z.array(Provider) }),
  createProvider: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/providers',
    body: CreateProviderBody,
    response: Provider,
  }),
  updateProvider: endpoint({
    method: 'PATCH',
    path: '/w/:workspaceId/providers/:providerId',
    body: UpdateProviderBody,
    response: Provider,
  }),
  deleteProvider: endpoint({ method: 'DELETE', path: '/w/:workspaceId/providers/:providerId', response: Ok }),
  testProvider: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/providers/:providerId/test',
    body: TestProviderBody,
    response: ConnectionTest,
  }),
  fetchProviderModels: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/providers/:providerId/fetch-models',
    response: z.array(ProviderModel),
  }),
  /** `?kind=embedding` / `?kind=image` list those models; chat models by default. */
  listProviderModels: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/providers/:providerId/models',
    query: ListProviderModelsQuery,
    response: z.array(ProviderModel),
  }),
  createProviderModel: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/providers/:providerId/models',
    body: CreateProviderModelBody,
    response: ProviderModel,
  }),
  updateProviderModel: endpoint({
    method: 'PATCH',
    path: '/w/:workspaceId/providers/:providerId/models/:modelId',
    body: UpdateProviderModelBody,
    response: ProviderModel,
  }),
  deleteProviderModel: endpoint({
    method: 'DELETE',
    path: '/w/:workspaceId/providers/:providerId/models/:modelId',
    response: Ok,
  }),
  testProviderDraft: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/provider-drafts/test',
    body: TestProviderDraftBody,
    response: ConnectionTest,
  }),
  fetchProviderDraftModels: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/provider-drafts/models',
    body: ProviderDraftModelsBody,
    response: z.array(DraftModel),
  }),
  /** Not saved; the user picks which to add. */
  fetchProviderDraftEmbeddingModels: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/provider-drafts/embedding-models',
    body: ProviderDraftModelsBody,
    response: EmbeddingModelCandidates,
  }),
  /** Whether an embedding model works and its vector size. */
  probeProviderDraftEmbedding: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/provider-drafts/embedding-probe',
    body: ProviderDraftEmbeddingProbeBody,
    response: EmbeddingProbeResult,
  }),
  /** Not saved; the user picks which to add. */
  fetchProviderDraftImageModels: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/provider-drafts/image-models',
    body: ProviderDraftModelsBody,
    response: ImageModelCandidates,
  }),
  /** Qwen3 Embedding with the prices OpenRouter lists now (skips models already there). */
  addSuggestedEmbeddingModels: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/providers/:providerId/embedding-models/suggested',
    response: z.array(ProviderModel),
  }),
  getProviderAccount: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/providers/:providerId/account',
    response: ProviderAccount,
  }),
}
