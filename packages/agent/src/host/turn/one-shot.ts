import type { ContextComposition } from '@milibot/shared'
import { type Bot, estimateTokens } from '@milibot/shared'

import { CLI_ENGINE_DRIVERS } from '../../cli/registry'
import type {
  BlobStore,
  LlmCallRecord,
  ModelResolver,
  ResolvedModel,
  Telemetry,
  WorkspaceReader,
  WriteTextRequest,
} from '../../environment'
import { type ContentPart, textOfParts } from '../../llm/messages'
import { complete, type CompletionResult, ProviderError } from '../../llm/provider'
import { type TokenUsage, ZERO_USAGE } from '../../llm/usage'
import type { SummarizeRequest } from '../../memory/compaction'
import { calibrateComposition, imageTokens } from '../../memory/tokens'
import type { CliEngines } from '../context'

export interface OneShotInput {
  bot: Bot
  resolved: Exclude<ResolvedModel, { kind: 'unavailable' }>
  record: { botId: string | null; conversationId: string | null; turnId?: string | null; purpose: string }
  system: string
  prompt: string
  /** Sent after the prompt; CLI one-shots are text only and skip them. */
  images?: ContentPart[]
  maxOutputTokens: number
  estimate: ContextComposition
  signal: AbortSignal
  onText?: (delta: string) => void
  label?: string
}

/** What a one-shot call needs of the environment. */
export type OneShotEnv = Pick<WorkspaceReader, 'now' | 'getBot'> &
  Pick<ModelResolver, 'resolveSummaryModel'> &
  Pick<Telemetry, 'recordLlmCall'> & { blobs: BlobStore }

export interface OneShotResult {
  text: string
  llmCallId: string | null
  /** `max_tokens` may mean it all went on reasoning. */
  stopReason: string
}

export function promptTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.cachedReadTokens + usage.cacheWriteTokens
}

/** Composition estimate of a one-shot call (no memory, retrieval or tools). */
export function oneShotEstimate(
  system: string,
  parts: { tail?: string; summaries?: string | null; images?: ContentPart[] },
): ContextComposition {
  const images = parts.images ?? []
  return {
    systemPrompt: estimateTokens(system),
    longTermMemory: 0,
    summaries: parts.summaries ? estimateTokens(parts.summaries) : 0,
    retrieved: 0,
    recentTail: parts.tail ? estimateTokens(parts.tail) : 0,
    tools: 0,
    ...(images.length
      ? {
          images: images.reduce(
            (sum, p) => sum + (p.type === 'image' ? imageTokens(p.width, p.height) : 0),
            0,
          ),
          imageCount: images.length,
        }
      : {}),
  }
}

/** Logs a native LLM call: its result, or the error it failed with (zero usage, the estimate as is). */
export function recordNativeCall(
  env: Pick<Telemetry, 'recordLlmCall'>,
  base: Pick<LlmCallRecord, 'botId' | 'conversationId' | 'turnId' | 'purpose'>,
  resolved: Extract<ResolvedModel, { kind: 'native' }>,
  estimate: ContextComposition,
  outcome: { result: CompletionResult } | { error: unknown; latencyMs: number },
): string {
  const call = {
    ...base,
    providerId: resolved.providerId,
    providerType: resolved.provider.type,
    model: resolved.model,
  }
  if ('result' in outcome) {
    const { result } = outcome
    return env.recordLlmCall({
      ...call,
      request: result.rawRequest,
      response: result.rawResponse,
      usage: result.usage,
      contextComposition: calibrateComposition(estimate, promptTokens(result.usage)),
      stopReason: result.stopReason,
      generationId: result.generationId,
      latencyMs: result.latencyMs,
      error: null,
    })
  }
  const providerError = outcome.error instanceof ProviderError ? outcome.error : null
  return env.recordLlmCall({
    ...call,
    request: providerError?.rawRequest ?? null,
    response: providerError?.rawResponse ?? null,
    usage: ZERO_USAGE,
    contextComposition: estimate,
    stopReason: 'error',
    generationId: null,
    latencyMs: outcome.latencyMs,
    error: (outcome.error as Error).message,
  })
}

/**
 * One tool-less completion (summaries, group triage), logged in `llm_calls`. A CLI engine runs a one-shot
 * process in the VM on behalf of `bot` (its display and label).
 */
export async function oneShot(env: OneShotEnv, cli: CliEngines, input: OneShotInput): Promise<OneShotResult> {
  const { resolved, estimate, signal } = input
  const base = { ...input.record, turnId: input.record.turnId ?? null }
  if (resolved.kind === 'native') {
    const started = env.now()
    try {
      const result = await complete(
        resolved.provider,
        {
          model: resolved.model,
          messages: [
            { role: 'system', content: [{ type: 'text', text: input.system }] },
            { role: 'user', content: [{ type: 'text', text: input.prompt }, ...(input.images ?? [])] },
          ],
          tools: [],
          blobs: env.blobs,
          maxOutputTokens: input.maxOutputTokens,
          effort: resolved.effort ?? 'low',
          signal,
        },
        input.onText,
      )
      const llmCallId = recordNativeCall(env, base, resolved, estimate, { result })
      return { text: textOfParts(result.message.content).trim(), llmCallId, stopReason: result.stopReason }
    } catch (err) {
      if (signal.aborted) throw err
      recordNativeCall(env, base, resolved, estimate, { error: err, latencyMs: env.now() - started })
      throw err
    }
  }
  const driver = CLI_ENGINE_DRIVERS[resolved.engine]
  const sessions = cli.get(resolved.engine)
  if (!sessions) throw new Error(`${driver.displayName} needs the workspace VM, which is not available`)
  const result = await sessions.oneShot({
    bot: input.bot,
    model: resolved.model,
    env: resolved.env,
    ...(resolved.config ? { providerConfig: resolved.config } : {}),
    effort: resolved.effort ?? null,
    systemPrompt: input.system,
    prompt: input.prompt,
    signal,
    maxOutputTokens: input.maxOutputTokens,
    ...(input.label ? { label: input.label } : {}),
    ...(input.onText ? { onText: input.onText } : {}),
  })
  const llmCallId = env.recordLlmCall({
    ...base,
    providerId: resolved.providerId,
    providerType: resolved.engine,
    model: result.model,
    request: { ...result.request, prompt: input.prompt },
    response: { text: result.text, ...result.details },
    ...result.billing,
    contextComposition: result.usage ? calibrateComposition(estimate, promptTokens(result.usage)) : estimate,
    stopReason: result.error ? 'error' : 'end_turn',
    generationId: null,
    latencyMs: result.durationMs,
    error: result.error,
  })
  if (result.error) throw new Error(result.error)
  return { text: result.text.trim(), llmCallId, stopReason: 'end_turn' }
}

/** A summary of conversation memory (`compaction.ts`), on the bot's summary model. */
export async function summarize(
  env: OneShotEnv,
  cli: CliEngines,
  bot: Bot,
  conversationId: string,
  request: SummarizeRequest,
  signal: AbortSignal,
): Promise<{ text: string; llmCallId: string | null }> {
  const resolved = await env.resolveSummaryModel(bot)
  if (resolved.kind === 'unavailable') throw new Error(resolved.reason)
  return oneShot(env, cli, {
    bot,
    resolved,
    record: { botId: bot.id, conversationId, purpose: request.level === 0 ? 'summary' : 'summary_merge' },
    system: request.system,
    prompt: request.prompt,
    maxOutputTokens: request.maxOutputTokens,
    estimate: oneShotEstimate(
      request.system,
      request.level === 0 ? { tail: request.prompt } : { summaries: request.prompt },
    ),
    signal,
  })
}

/** A tool-less completion on behalf of a bot outside any turn (`AgentHost.writeText`). */
export async function writeText(
  env: OneShotEnv,
  cli: CliEngines,
  input: WriteTextRequest,
): Promise<OneShotResult> {
  const bot = env.getBot(input.botId)
  if (!bot) throw new Error(`unknown bot ${input.botId}`)
  const resolved = input.model ?? (await env.resolveSummaryModel(bot))
  if (resolved.kind === 'unavailable') throw new Error(resolved.reason)
  const images = resolved.kind === 'native' ? (input.images ?? []) : []
  return oneShot(env, cli, {
    bot,
    resolved,
    record: {
      botId: bot.id,
      conversationId: input.conversationId,
      turnId: input.turnId ?? null,
      purpose: input.purpose,
    },
    system: input.system,
    prompt: input.prompt,
    images,
    maxOutputTokens: input.maxOutputTokens,
    estimate: oneShotEstimate(input.system, { tail: input.prompt, images }),
    signal: input.signal ?? new AbortController().signal,
    ...(input.onText ? { onText: input.onText } : {}),
    ...(input.label ? { label: input.label } : {}),
  })
}
