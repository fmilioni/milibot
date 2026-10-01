export type { ApiEmbeddingOptions } from './api'
export {
  findApiEmbeddingModel,
  findLocalEmbeddingLevel,
  LOCAL_EMBEDDING_FAMILIES,
  type LocalEmbeddingLevel,
  localEmbeddingSpaceKey,
  localSettingSpaceKey,
  recommendedLocalEmbeddingLevel,
} from './catalog'
export { listEmbeddingModels, probeEmbeddingModel } from './discovery'
export { createEmbeddingProvider, parseEmbeddingSetting } from './factory'
export { FakeEmbeddingProvider } from './fake'
export {
  DEFAULT_EMBEDDING_IDLE_UNLOAD_MS,
  defaultEmbeddingThreads,
  defaultEmbeddingWorkerUrl,
  embedWithLevel,
  isLocalModelDownloaded,
  localModelDiskBytes,
  LocalModelHost,
} from './local'
export { lexicalQueryWeight, reciprocalRankFusion } from './rrf'
export {
  EmbeddingError,
  type EmbeddingErrorCode,
  type EmbeddingKind,
  type EmbeddingProvider,
  type EmbeddingResult,
  type EmbeddingSetting,
  type EmbeddingUsage,
  type LocalEmbeddingFamilyId,
  type ModelDownloadProgress,
} from './types'
export { blobToInt8, int8ToBlob, type QuantizedVector, quantizeInt8 } from './vector'
export { Int8VectorIndex, type VectorSearchHit } from './vector-index'
