import { REASONING_EFFORTS, type ReasoningEffort } from './reasoning'

/**
 * Claude Code model aliases (`claude --model <alias>` always picks the latest of the family), with the
 * window and efforts of that latest model.
 */
export const CLAUDE_CODE_MODELS = [
  { id: 'fable', displayName: 'Fable', contextWindow: 1_000_000, efforts: REASONING_EFFORTS },
  { id: 'opus', displayName: 'Opus', contextWindow: 1_000_000, efforts: REASONING_EFFORTS },
  { id: 'sonnet', displayName: 'Sonnet', contextWindow: 1_000_000, efforts: REASONING_EFFORTS },
  { id: 'haiku', displayName: 'Haiku', contextWindow: 200_000, efforts: [] as readonly ReasoningEffort[] },
] as const
