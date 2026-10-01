import type { BotStatus } from '@milibot/shared'

import type { TranscriptEntry, WorkSessionDirectory, WorkSessionView } from '../environment'
import type { ChatMessage } from '../llm/messages'

/**
 * WorkSessionDirectory in memory: the views it is given (or finds through `lookup`) and each lane's stored
 * transcript and input position.
 */
export class InMemoryWorkSessions implements WorkSessionDirectory {
  readonly views = new Map<string, WorkSessionView>()
  entries: Array<{ seq: number; laneKey: string; message: ChatMessage; compacted: boolean }> = []
  summaries: Array<{ laneKey: string; toSeq: number; content: string }> = []
  inputSeqs = new Map<string, number>()
  laneStatuses: BotStatus[] = []
  counts: Array<{ running: number; total: number; ended?: string }> = []
  ready: string[] = []
  private seq = 0

  constructor(private readonly lookup: (sessionId: string) => WorkSessionView | null = () => null) {}

  get(id: string): WorkSessionView | null {
    return this.views.get(id) ?? this.lookup(id)
  }
  state(_id: string): string {
    return ''
  }
  laneStatus(_id: string, status: BotStatus): void {
    this.laneStatuses.push(status)
  }
  cliStarted(_id: string): number {
    return 0
  }
  recovery(_id: string): string {
    return ''
  }
  loadTranscript(_id: string, laneKey: string): { summary: string | null; entries: TranscriptEntry[] } {
    const summary = this.summaries.filter((s) => s.laneKey === laneKey).at(-1) ?? null
    return {
      summary: summary?.content ?? null,
      entries: this.entries
        .filter((e) => e.laneKey === laneKey && !e.compacted && e.seq > (summary?.toSeq ?? 0))
        .map((e) => ({ seq: e.seq, message: structuredClone(e.message) })),
    }
  }
  appendTranscript(_id: string, laneKey: string, _turnId: string | null, message: ChatMessage): number {
    this.entries.push({ seq: ++this.seq, laneKey, message: structuredClone(message), compacted: false })
    return this.seq
  }
  compactTranscript(_id: string, laneKey: string, toSeq: number, content: string): void {
    this.summaries.push({ laneKey, toSeq, content })
    for (const e of this.entries) if (e.laneKey === laneKey && e.seq <= toSeq) e.compacted = true
  }
  inputSeq(laneKey: string): number {
    return this.inputSeqs.get(laneKey) ?? 0
  }
  setInputSeq(laneKey: string, seq: number): void {
    this.inputSeqs.set(laneKey, seq)
  }
  subagents(_id: string, counts: { running: number; total: number }, endedLane?: string): void {
    this.counts.push({ ...counts, ...(endedLane ? { ended: endedLane } : {}) })
  }
  async ensureReady(id: string): Promise<void> {
    this.ready.push(id)
  }
}
