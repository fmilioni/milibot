import { REASONING_EFFORTS } from './reasoning'

/**
 * Codex CLI version installed in the VM (`npm i -g @openai/codex@<version>`). Pinned: the app-server protocol
 * changes between releases, so a bump means re-checking `packages/agent/src/codex/`.
 */
export const CODEX_VERSION = '0.159.2'

/**
 * Models listed by the Codex catalog of `CODEX_VERSION` (what `model/list` answers; the account decides which
 * of them it can use). `ultra` is left out: it makes the model delegate to sub-agents of its own. Prices are
 * OpenAI's Standard tier for up to 272k input tokens (US$ per 1M tokens; cache writes cost as input): what an
 * API key pays, and what a ChatGPT plan's turn would have cost.
 */
export const CODEX_MODELS = [
  {
    id: 'gpt-6.1-sol',
    displayName: 'GPT-6.1 Sol',
    contextWindow: 272_000,
    efforts: REASONING_EFFORTS,
    input: 2,
    cacheRead: 0.1,
    output: 10,
  },
  {
    id: 'gpt-6-astra',
    displayName: 'GPT-6 Astra',
    contextWindow: 272_000,
    efforts: REASONING_EFFORTS,
    input: 10,
    cacheRead: 1,
    output: 50,
  },
  {
    id: 'gpt-6-sol',
    displayName: 'GPT-6 Sol',
    contextWindow: 272_000,
    efforts: REASONING_EFFORTS,
    input: 2,
    cacheRead: 0.2,
    output: 10,
  },
  {
    id: 'gpt-6-luna',
    displayName: 'GPT-6 Luna',
    contextWindow: 272_000,
    efforts: REASONING_EFFORTS,
    input: 0.1,
    cacheRead: 0.01,
    output: 0.5,
  },
  {
    id: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    contextWindow: 272_000,
    efforts: REASONING_EFFORTS,
    input: 4,
    cacheRead: 0.4,
    output: 20,
  },
  {
    id: 'gpt-5.6-terra',
    displayName: 'GPT-5.6 Terra',
    contextWindow: 272_000,
    efforts: REASONING_EFFORTS,
    input: 2,
    cacheRead: 0.2,
    output: 12,
  },
  {
    id: 'gpt-5.6-luna',
    displayName: 'GPT-5.6 Luna',
    contextWindow: 272_000,
    efforts: REASONING_EFFORTS,
    input: 0.2,
    cacheRead: 0.02,
    output: 1.2,
  },
] as const

/** Linux user whose `~/.codex` holds the login every bot's Codex process uses. */
export const CODEX_HOME = '/home/agent/.codex'
