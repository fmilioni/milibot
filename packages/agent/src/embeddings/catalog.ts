import type { EmbeddingSetting, LocalEmbeddingFamilyId } from './types'

/** A model file set on Hugging Face, run with transformers.js + onnxruntime-node. */
export interface LocalEmbeddingModel {
  /** Short name used in space keys, e.g. `embeddinggemma-300m`. */
  name: string
  /** Hugging Face repo. */
  repo: string
  /** transformers.js `dtype` (which `onnx/model*.onnx` is loaded). */
  dtype: LocalModelDtype
  nativeDimensions: number
  maxInputTokens: number
  queryPrefix: string
  documentPrefix: string
  /**
   * `model`: the ONNX graph outputs a pooled, normalized `sentence_embedding` (EmbeddingGemma has dense
   * layers after pooling, so pooling `last_hidden_state` ourselves would be wrong).
   * `mean`: mean pooling over `last_hidden_state` with the attention mask, then L2 normalization.
   */
  pooling: 'model' | 'mean'
  /**
   * Padded tokens per forward pass (texts are sorted by length, so padding stays small). Throughput is
   * flat above a few texts per batch while activation memory grows with batch × length².
   */
  batchTokens: number
  /** Files relative to `<cacheDir>/<repo>/` that must exist for the model to load offline. */
  files: string[]
  /** Sum of `files` in the cache, measured. */
  downloadBytes: number
}

export interface LocalEmbeddingLevel {
  id: string
  family: LocalEmbeddingFamilyId
  model: LocalEmbeddingModel
  /** Output size; below `nativeDimensions` the vector is truncated (Matryoshka) and renormalized. */
  dimensions: number
  /**
   * Peak resident memory of the worker process while indexing ~600-token chunks (MB), measured with
   * `eval/knowledge`. Levels of the same model share the number: truncating dimensions only shrinks the
   * stored vectors (1 byte per dimension per chunk).
   */
  ramMb: number
  /** The option marked as recommended (exactly one level in the catalog). */
  recommended: boolean
}

export interface LocalEmbeddingFamily {
  id: LocalEmbeddingFamilyId
  name: string
  vendor: string
  levels: LocalEmbeddingLevel[]
}

/**
 * How Milibot talks to an API embedding model it knows. Names, prices, context and dimensions come
 * from the registered provider model, never from here.
 */
export interface ApiEmbeddingModelInfo {
  model: string
  /** Longest input, used for chunk sizes when the registered model has no context. */
  maxInputTokens: number
  queryPrefix: string
  documentPrefix: string
  /** Offered among the suggested models in the OpenRouter embedding table, when the provider lists it. */
  suggested: boolean
}

export type LocalModelDtype = 'q8' | 'q4' | 'fp32'

const DTYPE_SUFFIX: Record<LocalModelDtype, string> = { q8: '_quantized', q4: '_q4', fp32: '' }

/** Files transformers.js reads for a dtype; `externalData` = weights in a separate `.onnx_data` file. */
export function onnxModelFiles(dtype: LocalModelDtype, externalData: boolean): string[] {
  const graph = `onnx/model${DTYPE_SUFFIX[dtype]}.onnx`
  return [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    graph,
    ...(externalData ? [`${graph}_data`] : []),
  ]
}

/**
 * q4 (MatMulNBits, run natively in 4 bits) instead of q8: the q8 export dequantizes every weight to
 * fp32 on each run, so it peaks at ~1.8 GB and takes ~45 ms per query, against ~0.7 GB and ~12 ms in
 * q4, with the same retrieval quality on the eval; q8 indexes ~1.8× faster.
 */
const GEMMA: LocalEmbeddingModel = {
  name: 'embeddinggemma-300m',
  repo: 'onnx-community/embeddinggemma-300m-ONNX',
  dtype: 'q4',
  nativeDimensions: 768,
  maxInputTokens: 2048,
  queryPrefix: 'task: search result | query: ',
  documentPrefix: 'title: none | text: ',
  pooling: 'model',
  batchTokens: 2048,
  files: onnxModelFiles('q4', true),
  downloadBytes: 218_726_989,
}

function e5(size: 'small' | 'base' | 'large', dims: number, downloadBytes: number): LocalEmbeddingModel {
  return {
    name: `multilingual-e5-${size}`,
    repo: `Xenova/multilingual-e5-${size}`,
    dtype: 'q8',
    nativeDimensions: dims,
    maxInputTokens: 512,
    queryPrefix: 'query: ',
    documentPrefix: 'passage: ',
    pooling: 'mean',
    batchTokens: 2048,
    files: onnxModelFiles('q8', false),
    downloadBytes,
  }
}

const E5_SMALL = e5('small', 384, 135_392_016)
const E5_BASE = e5('base', 768, 295_731_426)
const E5_LARGE = e5('large', 1024, 578_852_632)

export const LOCAL_EMBEDDING_FAMILIES: readonly LocalEmbeddingFamily[] = [
  {
    id: 'embeddinggemma',
    name: 'EmbeddingGemma',
    vendor: 'Google',
    levels: [
      { id: 'max', family: 'embeddinggemma', model: GEMMA, dimensions: 768, ramMb: 720, recommended: true },
      {
        id: 'balanced',
        family: 'embeddinggemma',
        model: GEMMA,
        dimensions: 512,
        ramMb: 720,
        recommended: false,
      },
      {
        id: 'compact',
        family: 'embeddinggemma',
        model: GEMMA,
        dimensions: 256,
        ramMb: 720,
        recommended: false,
      },
    ],
  },
  {
    id: 'multilingual-e5',
    name: 'multilingual-e5',
    vendor: 'Microsoft',
    levels: [
      {
        id: 'small',
        family: 'multilingual-e5',
        model: E5_SMALL,
        dimensions: 384,
        ramMb: 980,
        recommended: false,
      },
      {
        id: 'base',
        family: 'multilingual-e5',
        model: E5_BASE,
        dimensions: 768,
        ramMb: 1290,
        recommended: false,
      },
      {
        id: 'large',
        family: 'multilingual-e5',
        model: E5_LARGE,
        dimensions: 1024,
        ramMb: 2080,
        recommended: false,
      },
    ],
  },
]

const QWEN_QUERY_PREFIX =
  'Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery: '

/** Instruction-tuned models that need a query prefix; any other model is used as is. */
export const API_EMBEDDING_MODELS: readonly ApiEmbeddingModelInfo[] = [
  {
    model: 'qwen/qwen3-embedding-4b',
    maxInputTokens: 32_768,
    queryPrefix: QWEN_QUERY_PREFIX,
    documentPrefix: '',
    suggested: true,
  },
  {
    model: 'qwen/qwen3-embedding-8b',
    maxInputTokens: 32_768,
    queryPrefix: QWEN_QUERY_PREFIX,
    documentPrefix: '',
    suggested: true,
  },
]

export function localEmbeddingLevels(): LocalEmbeddingLevel[] {
  return LOCAL_EMBEDDING_FAMILIES.flatMap((f) => f.levels)
}

export function findLocalEmbeddingLevel(family: string, level: string): LocalEmbeddingLevel | null {
  return LOCAL_EMBEDDING_FAMILIES.find((f) => f.id === family)?.levels.find((l) => l.id === level) ?? null
}

export function recommendedLocalEmbeddingLevel(): LocalEmbeddingLevel {
  const level = localEmbeddingLevels().find((l) => l.recommended)
  if (!level) throw new Error('embedding catalog has no recommended level')
  return level
}

export function findApiEmbeddingModel(model: string): ApiEmbeddingModelInfo | null {
  return API_EMBEDDING_MODELS.find((m) => m.model === model) ?? null
}

/** Setting used when `knowledge.embedding` was never chosen. */
export function defaultEmbeddingSetting(): EmbeddingSetting {
  const level = recommendedLocalEmbeddingLevel()
  return { provider: 'local', family: level.family, level: level.id }
}

export function localEmbeddingSpaceKey(level: LocalEmbeddingLevel): string {
  return `local:${level.model.name}:${level.model.dtype}:${level.dimensions}`
}

export function apiEmbeddingSpaceKey(providerId: string, model: string, dimensions: number): string {
  return `api:${providerId}:${model}:${dimensions}`
}

/** Space key of a local setting without building the provider; null for API settings (dims come from the API). */
export function localSettingSpaceKey(setting: EmbeddingSetting): string | null {
  if (setting.provider !== 'local') return null
  const level = findLocalEmbeddingLevel(setting.family, setting.level)
  return level ? localEmbeddingSpaceKey(level) : null
}
