import type { EventBus } from "../../src/application/ports";
import type { OutboxMessage } from "../../src/domain/outbox-message";

/** Test decorator around the real SQS event bus: records who published what, or simulates SQS down. */
export class RecordingBus implements EventBus {
  onPublished?: (eventId: string) => void;
  failWith?: Error;

  constructor(private readonly inner: EventBus) {}

  async publish(message: OutboxMessage): Promise<void> {
    if (this.failWith) throw this.failWith;
    await this.inner.publish(message);
    this.onPublished?.(message.id);
  }

  check(): Promise<void> {
    return this.inner.check();
  }
}
