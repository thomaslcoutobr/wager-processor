import type { Clock, EventBus, FailpointPort, UnitOfWork } from "./ports";

/**
 * One publisher pass (ARCHITECTURE §13), safe with N concurrent publishers:
 *   BEGIN; claim due rows FOR UPDATE SKIP LOCKED (disjoint batches); send each; mark published; COMMIT
 * At least once on purpose: dying between SendMessage and COMMIT rolls the marks back, the locks fall
 * with the connection and another publisher re-sends. MessageDeduplicationId = eventId collapses the
 * repeat inside the FIFO window and consumers dedupe by eventId after that.
 * Publishing never happens before the business commit: an event only exists as an outbox row of a
 * committed transaction.
 */
export class PublishOutboxBatch {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly bus: EventBus,
    private readonly clock: Clock,
    private readonly failpoints: FailpointPort,
    private readonly opts: { batchSize: number; random?: () => number },
  ) {}

  /** Returns how many rows were published. */
  async execute(): Promise<number> {
    return this.uow.run(
      async (store) => {
        const now = this.clock.now();
        const batch = await store.claimDueOutbox(now, this.opts.batchSize);
        const failedGroups = new Set<string>();
        let published = 0;
        for (const message of batch) {
          if (failedGroups.has(message.messageGroupId)) continue; // keep per-wallet order inside the batch
          try {
            await this.bus.publish(message);
          } catch (err) {
            message.scheduleRetry(now, String(err), this.opts.random);
            await store.saveOutboxProgress(message);
            failedGroups.add(message.messageGroupId);
            continue;
          }
          await this.failpoints.hit("outbox.after_send_before_commit");
          message.markPublished(now);
          await store.saveOutboxProgress(message);
          published++;
        }
        return published;
      },
      { name: "outbox", statementTimeoutMs: 10_000 },
    );
  }
}
