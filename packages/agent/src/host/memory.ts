import type { Bot, CliEngine } from '@milibot/shared'

import { type CliBootstrap, type CliStartup, EMPTY_BOOTSTRAP_SECTIONS } from '../cli/startup'
import { buildMemoryBootstrap, memoryDigest } from '../memory/bootstrap'
import { compactConversation } from '../memory/compaction'
import { fitMemoryConfig, type MemoryConfig, memoryConfig } from '../memory/types'
import { memoryChangedNote } from '../prompts/notes'
import type { HostContext } from './context'
import { laneInfo, type LaneKey } from './lanes'
import { summarize } from './turn/one-shot'

let emptyDigest: string | null = null

function emptyMemoryDigest(): string {
  emptyDigest ??= memoryDigest('')
  return emptyDigest
}

/** Conversation memory of the chat lanes: budgets, background compaction and the CLI engines' bootstrap. */
export class HostMemory {
  /** In-flight compactions by `botId:conversationId`; `rerun` asks for another pass after it. */
  private readonly compactions = new Map<string, { promise: Promise<void>; rerun: boolean }>()
  /** Registered context window of the model each bot last ran a native turn with (budgets fit it). */
  private readonly contextWindows = new Map<string, number | null>()

  constructor(private readonly ctx: HostContext) {}

  config(): MemoryConfig {
    return memoryConfig((key, fallback) => this.ctx.env().getSetting(key, fallback), this.ctx.options.memory)
  }

  /** Budgets fitted to a native turn's context window, remembered for the bot's next compaction. */
  forTurn(botId: string, contextWindow: number | null | undefined): MemoryConfig {
    this.contextWindows.set(botId, contextWindow ?? null)
    return fitMemoryConfig(this.config(), contextWindow)
  }

  pending(botId?: string): Array<Promise<void>> {
    return [...this.compactions.entries()]
      .filter(([key]) => !botId || key.startsWith(`${botId}:`))
      .map(([, c]) => c.promise)
  }

  scheduleCompaction(botId: string, conversationId: string): void {
    if (!this.ctx.options.compaction || !this.ctx.running()) return
    const key = `${botId}:${conversationId}`
    const existing = this.compactions.get(key)
    if (existing) {
      existing.rerun = true
      return
    }
    const entry = { promise: Promise.resolve(), rerun: false }
    this.compactions.set(key, entry)
    entry.promise = (async () => {
      do {
        entry.rerun = false
        await this.compact(botId, conversationId).catch((err: unknown) =>
          this.ctx
            .env()
            .log('warn', 'compaction failed', { botId, conversationId, err: (err as Error).message }),
        )
      } while (entry.rerun && this.ctx.running() && !this.ctx.background().aborted)
    })().finally(() => this.compactions.delete(key))
  }

  private async compact(botId: string, conversationId: string): Promise<void> {
    const env = this.ctx.env()
    const bot = env.getBot(botId)
    if (!bot || !env.getConversation(conversationId)) return
    const signal = this.ctx.background()
    const created = await compactConversation({
      bot,
      conversationId,
      memory: env.memory,
      botsById: this.ctx.botsById(),
      config: fitMemoryConfig(this.config(), this.contextWindows.get(botId)),
      summarize: (request) => summarize(env, this.ctx.cli, bot, conversationId, request, signal),
      signal,
    })
    if (created.length)
      env.log('info', 'conversation compacted', {
        botId,
        conversationId,
        summaries: created.map((s) => `L${s.level}:${s.fromSeq}-${s.toSeq}`),
      })
  }

  /**
   * Memory injected when a chat lane's CLI process starts. A fresh session gets pinned notes + summary chain +
   * recap in its system prompt addition (`--append-system-prompt-file`, Codex's developer instructions),
   * remembered per lane so every resume passes the byte-identical text. A resumed session gets later memory
   * changes as a note before its first input. Session rotation reuses this through `fresh = true`.
   */
  cliStartup(
    engine: CliEngine,
    bot: Bot,
    conversationId: string,
    laneKey: LaneKey,
  ): (fresh: boolean) => CliStartup {
    return (fresh) => {
      const env = this.ctx.env()
      const input = {
        bot,
        conversationId,
        memory: env.memory,
        botsById: this.ctx.botsById(),
        config: this.config(),
        knowledgeCatalog: this.ctx.knowledge.catalog(bot, laneInfo(laneKey).kind),
      }
      if (fresh) {
        const boot = buildMemoryBootstrap({ ...input, recap: true })
        env.hostState.setCliBootstrap(engine, laneKey, {
          appendix: boot.text,
          digest: boot.digest,
          sections: boot.sections,
        })
        return { systemAppendix: boot.text, inputPrefix: null, sections: boot.sections }
      }
      const stored: CliBootstrap | null = env.hostState.cliBootstrap(engine, laneKey)
      const appendix = stored?.appendix ?? ''
      const sections = stored?.sections ?? EMPTY_BOOTSTRAP_SECTIONS
      const current = buildMemoryBootstrap({ ...input, recap: false })
      if (current.digest === (stored?.digest ?? emptyMemoryDigest()))
        return { systemAppendix: appendix, inputPrefix: null, sections }
      env.hostState.setCliBootstrap(engine, laneKey, { appendix, digest: current.digest, sections })
      return {
        systemAppendix: appendix,
        inputPrefix: memoryChangedNote(current.text),
        sections: {
          longTermMemory: sections.longTermMemory + current.sections.longTermMemory,
          summaries: sections.summaries + current.sections.summaries,
          recap: sections.recap,
        },
      }
    }
  }
}
