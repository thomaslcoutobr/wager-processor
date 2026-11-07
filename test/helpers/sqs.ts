import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

export function sqsClient(): SQSClient {
  return new SQSClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    endpoint: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test", secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test" },
  });
}

export interface TestQueues {
  urls: { main: string; dlq: string; events: string; eventsDlq: string };
  /** Env for an app that should use these queues. */
  env: Record<string, string>;
}

async function createFifo(sqs: SQSClient, name: string, attrs: Record<string, string> = {}): Promise<string> {
  const r = await sqs.send(
    new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: "true", ContentBasedDeduplication: "true", ...attrs } }),
  );
  return r.QueueUrl!;
}

async function arnOf(sqs: SQSClient, url: string): Promise<string> {
  const r = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["QueueArn"] }));
  return r.Attributes!.QueueArn!;
}

/** A private set of the 4 FIFO queues (same attributes as the compose init) for one test file. */
export async function createTestQueues(label: string, opts: { visibilityTimeoutS?: number; maxReceiveCount?: number } = {}): Promise<TestQueues> {
  const sqs = sqsClient();
  const suffix = `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const maxReceive = String(opts.maxReceiveCount ?? 5);
  const visibility = String(opts.visibilityTimeoutS ?? 2);
  const dlq = await createFifo(sqs, `wtx-dlq-${suffix}.fifo`);
  const main = await createFifo(sqs, `wtx-${suffix}.fifo`, {
    VisibilityTimeout: visibility,
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: await arnOf(sqs, dlq), maxReceiveCount: maxReceive }),
  });
  const eventsDlq = await createFifo(sqs, `evt-dlq-${suffix}.fifo`);
  const events = await createFifo(sqs, `evt-${suffix}.fifo`, {
    VisibilityTimeout: visibility,
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: await arnOf(sqs, eventsDlq), maxReceiveCount: maxReceive }),
  });
  sqs.destroy();
  const name = (url: string) => url.split("/").pop()!;
  return {
    urls: { main, dlq, events, eventsDlq },
    env: {
      SQS_QUEUE_NAME: name(main),
      SQS_DLQ_NAME: name(dlq),
      SQS_EVENTS_QUEUE_NAME: name(events),
      SQS_EVENTS_DLQ_NAME: name(eventsDlq),
      SQS_VISIBILITY_TIMEOUT_S: visibility,
      SQS_WAIT_TIME_S: "1",
      SQS_MAX_RECEIVE_COUNT: maxReceive,
      SQS_RETRY_BASE_MS: "0",
      SQS_RETRY_MAX_MS: "0",
    },
  };
}

export function requestedEnvelope(data: Record<string, unknown>, messageId: string = crypto.randomUUID()) {
  return { messageId, type: "WagerTransactionRequested", occurredAt: new Date().toISOString(), data };
}

/** Sends a raw body. A fresh MessageDeduplicationId by default, so FIFO dedup never hides a redelivery. */
export async function sendRaw(url: string, body: string, groupId: string, dedupId: string = crypto.randomUUID()): Promise<void> {
  const sqs = sqsClient();
  try {
    await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: body, MessageGroupId: groupId, MessageDeduplicationId: dedupId }));
  } finally {
    sqs.destroy();
  }
}

export async function receiveAll(url: string, opts: { waitS?: number; max?: number; visibilityS?: number } = {}): Promise<Message[]> {
  const sqs = sqsClient();
  try {
    const r = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: opts.max ?? 10,
        WaitTimeSeconds: opts.waitS ?? 1,
        VisibilityTimeout: opts.visibilityS ?? 30,
        MessageSystemAttributeNames: ["All"],
        MessageAttributeNames: ["All"],
      }),
    );
    return r.Messages ?? [];
  } finally {
    sqs.destroy();
  }
}

/** Visible + in flight messages of a queue. */
export async function queueDepth(url: string): Promise<{ visible: number; inFlight: number }> {
  const sqs = sqsClient();
  try {
    const r = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
      }),
    );
    return {
      visible: Number(r.Attributes?.ApproximateNumberOfMessages ?? 0),
      inFlight: Number(r.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
    };
  } finally {
    sqs.destroy();
  }
}
