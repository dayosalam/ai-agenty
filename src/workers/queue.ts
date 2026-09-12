import { logger } from '../core/logger.js'

/**
 * A bounded-concurrency in-process queue.
 *
 * The socket handler must return immediately — a slow transcription running inline
 * would stall every message behind it. Nothing here is durable: WhatsApp re-delivers
 * on reconnect and the unique index makes that harmless, so a dropped in-flight job
 * costs one message, not correctness.
 */
export class Queue<T> {
  private readonly items: T[] = []
  private active = 0
  private draining: Array<() => void> = []

  constructor(
    private readonly handler: (item: T) => Promise<void>,
    private readonly concurrency: number,
    private readonly name = 'queue',
  ) {}

  push(item: T): void {
    this.items.push(item)
    this.pump()
  }

  get depth(): number {
    return this.items.length + this.active
  }

  /** Resolves once every queued item has been handled. Used by tests and shutdown. */
  async drain(): Promise<void> {
    if (this.depth === 0) return
    await new Promise<void>((resolve) => this.draining.push(resolve))
  }

  private pump(): void {
    while (this.active < this.concurrency && this.items.length > 0) {
      const item = this.items.shift()!
      this.active += 1
      void this.handler(item)
        // A failure here must never reach the socket handler — an unhandled rejection
        // would take WhatsApp ingestion down with it. See PRD §8.
        .catch((error) => logger.error({ err: error, queue: this.name }, 'queue item failed'))
        .finally(() => {
          this.active -= 1
          if (this.depth === 0) {
            this.draining.forEach((resolve) => resolve())
            this.draining = []
          }
          this.pump()
        })
    }
  }
}
