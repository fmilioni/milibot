import type { EmbeddingKind } from './types'

export interface QueuedEmbedding {
  /** Fairness key: document batches of different clients (workspaces) take turns. */
  client: string
  kind: EmbeddingKind
  texts: string[]
}

/**
 * Waiting embedding requests of one model. Queries (someone is waiting for a search) always go first and
 * are merged into one run; document batches go one at a time, round-robin across clients, so a big
 * reindex of one workspace never starves another's.
 */
export class EmbedQueue<J extends QueuedEmbedding> {
  private readonly queries: J[] = []
  /** Insertion order is the turn order: a client that got a turn moves to the end. */
  private readonly documents = new Map<string, J[]>()

  get size(): number {
    let size = this.queries.length
    for (const jobs of this.documents.values()) size += jobs.length
    return size
  }

  push(job: J): void {
    if (job.kind === 'query') {
      this.queries.push(job)
      return
    }
    const jobs = this.documents.get(job.client)
    if (jobs) jobs.push(job)
    else this.documents.set(job.client, [job])
  }

  remove(job: J): boolean {
    const list = job.kind === 'query' ? this.queries : this.documents.get(job.client)
    const index = list?.indexOf(job) ?? -1
    if (!list || index < 0) return false
    list.splice(index, 1)
    if (job.kind === 'document' && list.length === 0) this.documents.delete(job.client)
    return true
  }

  /** The next run: every waiting query (up to `maxQueryTexts` texts, at least one), else one document batch. */
  next(maxQueryTexts: number): J[] {
    if (this.queries.length > 0) {
      const run: J[] = []
      let texts = 0
      while (this.queries.length > 0) {
        const job = this.queries[0] as J
        if (run.length > 0 && texts + job.texts.length > maxQueryTexts) break
        run.push(job)
        texts += job.texts.length
        this.queries.shift()
      }
      return run
    }
    for (const [client, jobs] of this.documents) {
      const job = jobs.shift() as J
      this.documents.delete(client)
      if (jobs.length > 0) this.documents.set(client, jobs)
      return [job]
    }
    return []
  }

  drain(): J[] {
    const all = [...this.queries, ...[...this.documents.values()].flat()]
    this.queries.length = 0
    this.documents.clear()
    return all
  }
}
