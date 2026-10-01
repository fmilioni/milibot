import type { LocalEmbeddingModel } from './catalog'
import type { EmbeddingErrorCode, ModelDownloadProgress } from './types'

/** Config of an embedding worker process (one per model), passed as JSON in `argv[2]`. */
export interface EmbeddingWorkerConfig {
  cacheDir: string
  model: LocalEmbeddingModel
  /** onnxruntime intra-op threads. */
  threads: number
  /** Hugging Face mirror (tests); default `https://huggingface.co/`. */
  remoteHost?: string
}

export type EmbeddingWorkerRequest =
  | { type: 'load'; id: number }
  | { type: 'embed'; id: number; texts: string[] }
  | { type: 'cancel'; id: number }
  | { type: 'stats'; id: number }

export type EmbeddingWorkerResponse =
  | { type: 'progress'; progress: ModelDownloadProgress }
  | { type: 'loaded'; id: number; loadMs: number; downloaded: boolean }
  /** Native-size, unit-length vectors in input order; `counts` = tokens of each text. */
  | { type: 'result'; id: number; vectors: Float32Array[]; tokens: number; counts: number[] }
  | { type: 'stats'; id: number; rssBytes: number; peakRssBytes: number }
  | { type: 'error'; id: number; code: EmbeddingErrorCode; message: string }
