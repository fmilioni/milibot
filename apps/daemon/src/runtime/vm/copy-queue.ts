import type { LogFn } from '@milibot/shared'

import { errorMessage } from '../../errors'
import { isVmRunning, type VmController, whenVmRunning } from './controller'

/**
 * Work that reaches into the VM only while it runs (files copied in lazily): `run` goes once when the VM
 * comes up and whenever `kick` asks. One run at a time; a kick during a run schedules one more after it, and
 * its promise resolves when that later run ends.
 */
export class VmCopyQueue {
  private running: Promise<void> | null = null
  private next: Promise<void> | null = null
  private unsubscribe: (() => void) | null = null
  private stopped = false

  constructor(
    private readonly options: {
      name: string
      vm: Pick<VmController, 'status' | 'subscribe'>
      run: () => Promise<void>
      log?: LogFn
    },
  ) {}

  start(): void {
    this.stopped = false
    this.unsubscribe = whenVmRunning(this.options.vm, () => void this.kick())
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.unsubscribe?.()
    this.unsubscribe = null
    await this.idle()
  }

  kick(): Promise<void> {
    if (this.stopped || !isVmRunning(this.options.vm)) return Promise.resolve()
    if (this.running) {
      this.next ??= this.running.then(() => {
        this.next = null
        return this.kick()
      })
      return this.next
    }
    this.running = this.options
      .run()
      .catch((err: unknown) =>
        this.options.log?.('warn', `${this.options.name} failed`, { err: errorMessage(err) }),
      )
      .finally(() => {
        this.running = null
      })
    return this.running
  }

  /** Resolves once no run is going or queued. */
  async idle(): Promise<void> {
    while (this.running || this.next) await (this.next ?? this.running)
  }
}
