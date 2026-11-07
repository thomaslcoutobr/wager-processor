import { GetQueueAttributesCommand, GetQueueUrlCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { EventBus } from "../../application/ports";
import type { OutboxMessage } from "../../domain/outbox-message";
import type { AppConfig } from "../config";

export function createSqsClient(cfg: AppConfig["sqs"]): SQSClient {
  return new SQSClient({
    region: cfg.region,
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
    maxAttempts: 2,
  });
}

/** Resolves (and caches) queue URLs by name; the URL embeds account and region of the emulator/AWS. */
export class QueueDirectory {
  private readonly cache = new Map<string, Promise<string>>();

  constructor(private readonly sqs: SQSClient) {}

  url(name: string): Promise<string> {
    let p = this.cache.get(name);
    if (!p) {
      p = this.sqs.send(new GetQueueUrlCommand({ QueueName: name })).then((r) => {
        if (!r.QueueUrl) throw new Error(`queue ${name} not found`);
        return r.QueueUrl;
      });
      p.catch(() => this.cache.delete(name)); // do not cache failures
      this.cache.set(name, p);
    }
    return p;
  }

  async probe(name: string, timeoutMs: number): Promise<void> {
    await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: await this.url(name), AttributeNames: ["QueueArn"] }), {
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
  }
}

/** Publishes outbox rows to wager-events.fifo. MessageDeduplicationId = eventId; group = wallet. */
export class SqsEventBus implements EventBus {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: QueueDirectory,
    private readonly queueName: string,
    private readonly timeoutMs = 5_000,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: await this.queues.url(this.queueName),
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.messageGroupId,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: { DataType: "String", StringValue: message.eventType },
          eventVersion: { DataType: "Number", StringValue: String(message.eventVersion) },
        },
      }),
      { abortSignal: AbortSignal.timeout(this.timeoutMs) },
    );
  }

  check(): Promise<void> {
    return this.queues.probe(this.queueName, 1_000);
  }
}
