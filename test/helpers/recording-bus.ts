import type { EventBus } from "../../src/application/ports";
import type { OutboxMessage } from "../../src/domain/outbox-message";

/** Test decorator around the real SQS event bus: records who published what, or simulates SQS down. */
export class RecordingBus implements EventBus {
  onPublished?: (eventId: string) => void;
  failWith?: Error;
  /** Simulates a slow SQS: each publish takes this long before reaching the real bus. */
  delayMs = 0;

  constructor(private readonly inner: EventBus) {}

  async publish(message: OutboxMessage): Promise<void> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failWith) throw this.failWith;
    await this.inner.publish(message);
    this.onPublished?.(message.id);
  }

  check(): Promise<void> {
    return this.inner.check();
  }
}
