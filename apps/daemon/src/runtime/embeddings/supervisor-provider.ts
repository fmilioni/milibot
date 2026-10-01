import {
  EmbeddingError,
  type EmbeddingErrorCode,
  type EmbeddingKind,
  type EmbeddingProvider,
  type EmbeddingResult,
  isLocalModelDownloaded,
  type LocalEmbeddingLevel,
  localEmbeddingSpaceKey,
  type ModelDownloadProgress,
} from '@milibot/agent/embeddings'

import { errorMessage } from '../../errors'
import { RuntimeCallError, type SupervisorCallClient } from '../../ipc/calls'
import type { EmbeddingModelRef } from '../../ipc/protocol'
import { decodeVectors } from '../../ipc/vectors'

/** Without progress, a download or load this long is considered stuck. */
const PREPARE_TIMEOUT_MS = 10 * 60_000
/** Includes waiting behind other workspaces' batches in the shared queue. */
const EMBED_TIMEOUT_MS = 10 * 60_000

const EMBEDDING_ERROR_CODES = new Set<string>([
  'model_download_failed',
  'model_load_failed',
  'inference_failed',
  'aborted',
  'invalid_setting',
] satisfies EmbeddingErrorCode[])

function toEmbeddingError(err: unknown, fallback: EmbeddingErrorCode): EmbeddingError {
  if (err instanceof EmbeddingError) return err
  const message = errorMessage(err)
  if (err instanceof RuntimeCallError && EMBEDDING_ERROR_CODES.has(err.code))
    return new EmbeddingError(err.code as EmbeddingErrorCode, message)
  return new EmbeddingError(fallback, message)
}

/**
 * A local catalog level whose model runs in the supervisor's shared worker process (one per model for all
 * workspaces, see `SharedEmbeddingModels`), reached over the runtime IPC channel. Same space key, size and
 * input limit as `LocalEmbeddingProvider`, so vectors are interchangeable.
 */
export class SharedLocalEmbeddingProvider implements EmbeddingProvider {
  readonly key: string
  readonly dimensions: number
  readonly maxInputTokens: number
  private ready = false
  private readonly ref: EmbeddingModelRef

  constructor(
    readonly level: LocalEmbeddingLevel,
    private readonly deps: {
      calls: SupervisorCallClient
      modelsDir: string
      onProgress?: (progress: ModelDownloadProgress) => void
    },
  ) {
    this.key = localEmbeddingSpaceKey(level)
    this.dimensions = level.dimensions
    this.maxInputTokens = level.model.maxInputTokens
    this.ref = { family: level.family, level: level.id }
  }

  /** Whether this runtime already saw the model answer (the supervisor may unload it when idle). */
  get loaded(): boolean {
    return this.ready
  }

  isDownloaded(): boolean {
    return isLocalModelDownloaded(this.deps.modelsDir, this.level.model)
  }

  async prepare(signal?: AbortSignal): Promise<{ loadMs: number; downloaded: boolean }> {
    try {
      const result = await this.deps.calls.call(
        'embedding.prepare',
        this.ref,
        this.callOptions(PREPARE_TIMEOUT_MS, signal),
      )
      this.ready = true
      return result
    } catch (err) {
      throw toEmbeddingError(err, 'model_load_failed')
    }
  }

  async embed(texts: string[], kind: EmbeddingKind, signal?: AbortSignal): Promise<EmbeddingResult> {
    if (texts.length === 0) return { vectors: [], usage: { tokens: 0 } }
    try {
      const result = await this.deps.calls.call(
        'embedding.embed',
        { ...this.ref, texts, kind },
        this.callOptions(EMBED_TIMEOUT_MS, signal),
      )
      this.ready = true
      return { vectors: decodeVectors(result.vectors, result.dimensions), usage: { tokens: result.tokens } }
    } catch (err) {
      throw toEmbeddingError(err, 'inference_failed')
    }
  }

  async dispose(): Promise<void> {}

  private callOptions(timeoutMs: number, signal?: AbortSignal) {
    return {
      timeoutMs,
      ...(signal ? { signal } : {}),
      ...(this.deps.onProgress ? { onProgress: this.deps.onProgress } : {}),
    }
  }
}
