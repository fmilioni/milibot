import { lexicalQueryWeight } from '@milibot/agent/embeddings'

export interface KnowledgeThresholds {
  /** Cosine similarity for a document suggestion (summary vector vs the turn's input). */
  suggestMinScore: number
  /** Cosine similarity for an automatic excerpt. */
  chunkMinScore: number
  /** Query terms that a text-only match must share. */
  minTerms: number
  /** Same, for prose queries when vectors are available (text-only matches then only fill the list). */
  proseMinTerms: number
  /** A neighbouring chunk joins a hit when its similarity is at least this share of the seed's. */
  mergeMinRatio: number
}

/**
 * Measured with `eval/knowledge/thresholds.ts` (pt-BR corpus, 64 chat messages, 21 summaries): the
 * suggestion threshold is the best F1 that keeps ~86% of the messages about no document silent, the
 * excerpt threshold favours precision (they cost ~1k tokens per turn). Cosines depend on the model:
 * multilingual-e5 puts unrelated texts at ~0.8, so its thresholds are much higher and neighbours only
 * merge when almost as close as the seed. Models without an entry (API models, fake embeddings) use
 * the defaults, EmbeddingGemma's values.
 */
export const DEFAULT_THRESHOLDS: KnowledgeThresholds = {
  suggestMinScore: 0.35,
  chunkMinScore: 0.4,
  minTerms: 2,
  proseMinTerms: 3,
  mergeMinRatio: 0.85,
}

const E5 = { mergeMinRatio: 0.97 }

/** By `<model name>:<dimensions>` of a local space key (`local:<name>:<dtype>:<dims>`). */
const BY_MODEL: Record<string, Partial<KnowledgeThresholds>> = {
  'embeddinggemma-300m:768': { suggestMinScore: 0.35, chunkMinScore: 0.4 },
  'embeddinggemma-300m:512': { suggestMinScore: 0.34, chunkMinScore: 0.4 },
  'embeddinggemma-300m:256': { suggestMinScore: 0.42, chunkMinScore: 0.44 },
  'multilingual-e5-small:384': { ...E5, suggestMinScore: 0.86, chunkMinScore: 0.84 },
  'multilingual-e5-base:768': { ...E5, suggestMinScore: 0.84, chunkMinScore: 0.81 },
  'multilingual-e5-large:1024': { ...E5, suggestMinScore: 0.84, chunkMinScore: 0.82 },
}

export function thresholdsForSpace(space: string | null): KnowledgeThresholds {
  const [kind, name, , dims] = space?.split(':') ?? []
  const measured = kind === 'local' ? BY_MODEL[`${name}:${dims}`] : undefined
  return { ...DEFAULT_THRESHOLDS, ...measured }
}

/** Terms a text-only match needs for this query. */
export function textMinTerms(
  thresholds: Pick<KnowledgeThresholds, 'minTerms' | 'proseMinTerms'>,
  query: string,
  hasVector: boolean,
): number {
  return hasVector && lexicalQueryWeight(query) === 0 ? thresholds.proseMinTerms : thresholds.minTerms
}
