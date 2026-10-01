import type { KnowledgeEmbeddingSetting, LocalEmbeddingFamily } from '@milibot/shared'

export type EmbeddingKind = 'query' | 'document'

export interface EmbeddingUsage {
  tokens: number
  /** Set by API providers (reported by the provider or computed from the price per token). */
  costUsd?: number
}

export interface EmbeddingResult {
  /** One unit-length vector per input text, in input order, each `dimensions` long. */
  vectors: Float32Array[]
  usage?: EmbeddingUsage
}

export interface EmbeddingProvider {
  /**
   * Vector space id. Two providers with the same key produce comparable vectors, so stored vectors
   * are reusable (e.g. `local:embeddinggemma-300m:q4:768`, `api:<providerId>:<model>:<dims>`).
   */
  readonly key: string
  readonly dimensions: number
  /** Longer inputs are truncated by the provider; chunkers should stay below this. */
  readonly maxInputTokens: number
  embed(texts: string[], kind: EmbeddingKind, signal?: AbortSignal): Promise<EmbeddingResult>
  /** Releases the model/worker (local) or nothing (API). Safe to call more than once. */
  dispose?(): Promise<void>
}

/** Value of the workspace setting `knowledge.embedding`. */
export type EmbeddingSetting = KnowledgeEmbeddingSetting

export type LocalEmbeddingFamilyId = LocalEmbeddingFamily

export type EmbeddingErrorCode =
  /** The model files could not be downloaded (offline, Hugging Face down, disk full…). */
  | 'model_download_failed'
  /** The files are there but onnxruntime could not load them. */
  | 'model_load_failed'
  | 'inference_failed'
  | 'aborted'
  /** API provider answered with an error (see `status`). */
  | 'provider_error'
  | 'invalid_response'
  | 'invalid_setting'
  /** The chosen API model is not (or no longer) a registered, enabled provider model. */
  | 'model_not_registered'

export class EmbeddingError extends Error {
  constructor(
    readonly code: EmbeddingErrorCode,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message)
    this.name = 'EmbeddingError'
  }
}

/** Download progress of a local model (aggregated over all its files). */
export interface ModelDownloadProgress {
  modelId: string
  loadedBytes: number
  totalBytes: number
  /** 0–1. */
  progress: number
  /** Current file, when known. */
  file: string | null
  done: boolean
}
