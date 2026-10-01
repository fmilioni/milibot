import {
  DEFAULT_EMBEDDING_IDLE_UNLOAD_MS,
  defaultEmbeddingThreads,
  defaultEmbeddingWorkerUrl,
  EmbeddingError,
  embedWithLevel,
  findLocalEmbeddingLevel,
  type LocalEmbeddingLevel,
  LocalModelHost,
  type ModelDownloadProgress,
} from '@milibot/agent/embeddings'
import type { LogFn } from '@milibot/shared'

import type { RuntimeCallContext, RuntimeCallHandlers } from '../ipc/calls'
import type { EmbeddingModelRef } from '../ipc/protocol'
import { encodeVectors } from '../ipc/vectors'

export interface SharedEmbeddingModelsOptions {
  /** `<dataRoot>/models`. */
  cacheDir: string
  workerUrl?: URL
  idleUnloadMs?: number
  threads?: number
  remoteHost?: string
  log: LogFn
}

/**
 * The local embedding models of every workspace: one worker process per model in the supervisor (instead
 * of one per workspace runtime), started on demand and unloaded after the idle timeout. Requests of the
 * runtimes queue in the model's `LocalModelHost` (queries first, document batches round-robin across
 * workspaces); download progress goes to every call waiting on that model.
 */
export class SharedEmbeddingModels {
  private readonly hosts = new Map<
    string,
    { host: LocalModelHost; waiting: Set<(p: ModelDownloadProgress) => void> }
  >()

  constructor(private readonly options: SharedEmbeddingModelsOptions) {}

  runningProcesses(): number {
    return [...this.hosts.values()].filter((h) => h.host.running).length
  }

  /** Worker processes started since the supervisor started. */
  spawnCount(): number {
    return [...this.hosts.values()].reduce((sum, h) => sum + h.host.spawnCount, 0)
  }

  pids(): number[] {
    return [...this.hosts.values()].flatMap((h) => (h.host.pid === null ? [] : [h.host.pid]))
  }

  handlers(): RuntimeCallHandlers {
    return {
      'embedding.prepare': (args, context) =>
        this.withModel(args, context, ({ host }) => host.load(context.signal)),
      'embedding.embed': (args, context) =>
        this.withModel(args, context, async ({ host, level }) => {
          const result = await embedWithLevel(host, level, args.texts, args.kind, {
            signal: context.signal,
            client: context.client,
          })
          return {
            vectors: encodeVectors(result.vectors),
            dimensions: level.dimensions,
            tokens: result.usage?.tokens ?? 0,
          }
        }),
    }
  }

  async close(): Promise<void> {
    const hosts = [...this.hosts.values()]
    this.hosts.clear()
    await Promise.all(hosts.map(({ host }) => host.unload('shutdown')))
  }

  private entry(level: LocalEmbeddingLevel) {
    const key = `${level.model.repo}\n${level.model.dtype}`
    let entry = this.hosts.get(key)
    if (!entry) {
      const waiting = new Set<(p: ModelDownloadProgress) => void>()
      const host = new LocalModelHost(level.model, {
        cacheDir: this.options.cacheDir,
        threads: this.options.threads ?? defaultEmbeddingThreads(),
        idleUnloadMs: this.options.idleUnloadMs ?? DEFAULT_EMBEDDING_IDLE_UNLOAD_MS,
        workerUrl: this.options.workerUrl ?? defaultEmbeddingWorkerUrl(),
        ...(this.options.remoteHost ? { remoteHost: this.options.remoteHost } : {}),
        log: (level, message, extra) => this.options.log(level, message, extra),
      })
      host.onProgress((progress) => {
        for (const listener of waiting) listener(progress)
      })
      entry = { host, waiting }
      this.hosts.set(key, entry)
    }
    return entry
  }

  private async withModel<T>(
    ref: EmbeddingModelRef,
    context: RuntimeCallContext<ModelDownloadProgress>,
    run: (target: { host: LocalModelHost; level: LocalEmbeddingLevel }) => Promise<T>,
  ): Promise<T> {
    const level = findLocalEmbeddingLevel(ref.family, ref.level)
    if (!level) throw new EmbeddingError('invalid_setting', `unknown local model ${ref.family}/${ref.level}`)
    const { host, waiting } = this.entry(level)
    const listener = (progress: ModelDownloadProgress) => context.progress(progress)
    waiting.add(listener)
    try {
      return await run({ host, level })
    } finally {
      waiting.delete(listener)
    }
  }
}
