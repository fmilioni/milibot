/** Something the runtime starts after building everything and stops when it shuts down. */
export interface Component {
  name: string
  start?(): void | Promise<void>
  stop?(): void | Promise<void>
}

/**
 * Starts components in the order given and stops the started ones in reverse. A failing `stop` is reported
 * and the others still stop; a failing `start` stops what already started and rethrows.
 */
export class Lifecycle {
  private readonly components: Component[] = []
  private started: Component[] = []

  constructor(private readonly onStopError: (name: string, err: unknown) => void = () => undefined) {}

  add(...components: Component[]): this {
    this.components.push(...components)
    return this
  }

  async start(): Promise<void> {
    for (const component of this.components) {
      try {
        await component.start?.()
      } catch (err) {
        await this.stop()
        throw err
      }
      this.started.push(component)
    }
  }

  async stop(): Promise<void> {
    const started = this.started.reverse()
    this.started = []
    for (const component of started) {
      try {
        await component.stop?.()
      } catch (err) {
        this.onStopError(component.name, err)
      }
    }
  }
}
