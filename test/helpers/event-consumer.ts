import { DeleteMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import type { SQL } from "bun";
import { sqsClient } from "./sqs";

/**
 * Reference consumer of wager-events.fifo (tests only). It dedupes by eventId through the same
 * inbox_messages table (consumer_name = 'reference-event-consumer') and applies a deliberately
 * NON-idempotent effect (an INSERT without unique key) in the same transaction, so a duplicate that
 * slipped through would show up as a second effect row.
 */
export class ReferenceEventConsumer {
  static readonly NAME = "reference-event-consumer";

  constructor(
    private readonly owner: SQL,
    private readonly queueUrl: string,
  ) {}

  async setup(): Promise<void> {
    await this.owner.unsafe(`create table if not exists test_event_effects (seq bigserial primary key, event_id text not null, event_type text not null)`);
  }

  /** Drains the queue until it stays empty; returns how many deliveries were handled. */
  async drain(maxIdlePolls = 2): Promise<number> {
    const sqs = sqsClient();
    let handled = 0;
    let idle = 0;
    try {
      while (idle < maxIdlePolls) {
        const r = await sqs.send(new ReceiveMessageCommand({ QueueUrl: this.queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 30 }));
        const msgs = r.Messages ?? [];
        idle = msgs.length === 0 ? idle + 1 : 0;
        for (const m of msgs) {
          const env = JSON.parse(m.Body!) as { eventId: string; eventType: string };
          await this.owner.begin(async (tx) => {
            const inserted = await tx`insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
                                      values (${ReferenceEventConsumer.NAME}, ${env.eventId}, 'event', now(), now())
                                      on conflict do nothing returning message_id`;
            if (inserted.length === 1) {
              await tx`insert into test_event_effects (event_id, event_type) values (${env.eventId}, ${env.eventType})`;
            }
          });
          await sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: m.ReceiptHandle! }));
          handled++;
        }
      }
    } finally {
      sqs.destroy();
    }
    return handled;
  }

  async effectsPerEvent(): Promise<Map<string, number>> {
    const rows = await this.owner`select event_id, count(*)::int as n from test_event_effects group by event_id`;
    return new Map(rows.map((r: { event_id: string; n: number }) => [r.event_id, r.n]));
  }
}
