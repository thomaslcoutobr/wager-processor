import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { enrichLogContext, withLogContext } from "../../application/log-context";
import type { FailpointPort } from "../../application/ports";
import type { MessageOutcome, ProcessWagerMessage } from "../../application/process-wager-message";
import type { Logger } from "../observability/logger";
import type { PromMetrics } from "../observability/metrics";
import type { BackgroundJob } from "../workers/background-jobs";
import type { QueueDirectory } from "./sqs";

export interface ConsumerConfig {
  queueName: string;
  dlqName: string;
  /** Equal to the queue's maxReceiveCount: the app dead-letters on the last attempt, with the reason. */
  maxReceiveCount: number;
  visibilityTimeoutS: number;
  waitTimeS: number;
  batchSize: number;
  retryBaseMs: number;
  retryMaxMs: number;
  shutdownGraceMs: number;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

/**
 * Own SQS consumer (~200 lines) so the decisions under evaluation are visible (ARCHITECTURE §12):
 * ack only after COMMIT, three error classes, retry by ChangeMessageVisibility with full jitter,
 * DLQ with the reason, per-group order inside a batch, drain-or-hand-back on SIGTERM.
 */
export class SqsConsumer implements BackgroundJob {
  readonly name = "sqs-consumer";
  private stopping = new AbortController();
  private poller: Promise<void> | undefined;
  private readonly held = new Map<string, string>(); // SQS MessageId → receipt handle
  private readonly active = new Set<Promise<void>>();

  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: QueueDirectory,
    private readonly handler: ProcessWagerMessage,
    private readonly cfg: ConsumerConfig,
    private readonly metrics: PromMetrics,
    private readonly failpoints: FailpointPort,
    private readonly log: Logger,
    private readonly random: () => number = Math.random,
  ) {}

  start(): void {
    if (this.poller) return;
    this.stopping = new AbortController();
    this.poller = this.pollLoop();
  }

  async stop(): Promise<void> {
    if (!this.poller) return;
    this.stopping.abort(); // cancels the pending long poll; no new ReceiveMessage leaves
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      Promise.allSettled([this.poller, ...this.active]).then(() => true),
      new Promise<boolean>((resolve) => {
        graceTimer = setTimeout(() => resolve(false), this.cfg.shutdownGraceMs);
      }),
    ]).finally(() => clearTimeout(graceTimer)); // a pending timer would keep the event loop alive
    if (!drained) {
      this.log("warn", "shutdown grace exceeded, handing messages back", { held: this.held.size });
      await Promise.allSettled([...this.held.values()].map((r) => this.release(r)));
      // the handler still running must not commit after its message was handed back: leave now.
      // Postgres rolls the open transaction back when the connection drops.
      setTimeout(() => process.exit(1), 200).unref();
    }
    this.poller = undefined;
    this.log("info", "sqs consumer stopped", { drained });
  }

  private async queueUrl(): Promise<string> {
    return this.queues.url(this.cfg.queueName);
  }

  private async pollLoop(): Promise<void> {
    let failures = 0;
    while (!this.stopping.signal.aborted) {
      try {
        const res = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: await this.queueUrl(),
            MaxNumberOfMessages: this.cfg.batchSize,
            WaitTimeSeconds: this.cfg.waitTimeS,
            VisibilityTimeout: this.cfg.visibilityTimeoutS,
            MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
          }),
          { abortSignal: this.stopping.signal },
        );
        failures = 0;
        // FIFO: different groups (wallets) in parallel, the same group in sequence
        const groups = new Map<string, Message[]>();
        for (const m of res.Messages ?? []) {
          const g = m.Attributes?.MessageGroupId ?? m.MessageId ?? "unknown";
          groups.set(g, [...(groups.get(g) ?? []), m]);
        }
        await Promise.all(
          [...groups.values()].map((msgs) => {
            const p: Promise<void> = this.processGroup(msgs).finally(() => this.active.delete(p));
            this.active.add(p);
            return p;
          }),
        );
      } catch (err) {
        if (this.stopping.signal.aborted) break; // expected AbortError on shutdown
        failures++;
        const wait = Math.min(30_000, 500 * 2 ** failures);
        this.log("error", "sqs receive failed", { err: String(err), retryInMs: wait });
        await sleep(wait, this.stopping.signal);
      }
    }
  }

  private async processGroup(messages: Message[]): Promise<void> {
    for (let i = 0; i < messages.length; i++) {
      if (this.stopping.signal.aborted) {
        await this.releaseAll(messages.slice(i)); // not started: hand back right away
        return;
      }
      const ok = await this.processOne(messages[i]!);
      if (!ok) {
        // the next ones of the same group must not overtake the one that failed
        await this.releaseAll(messages.slice(i + 1));
        return;
      }
    }
  }

  /** Returns true when the message was acked. Runs in its own log context (messageId, correlationId…). */
  private processOne(msg: Message): Promise<boolean> {
    return withLogContext({ sqsMessageId: msg.MessageId }, () => this.processInContext(msg));
  }

  private async processInContext(msg: Message): Promise<boolean> {
    const sqsId = msg.MessageId ?? "unknown";
    const receipt = msg.ReceiptHandle!;
    const receiveCount = Number(msg.Attributes?.ApproximateReceiveCount ?? "1");
    this.held.set(sqsId, receipt);
    const fields: Record<string, unknown> = { receiveCount };
    try {
      this.log("info", "processing message", fields);
      let outcome: MessageOutcome;
      try {
        outcome = await this.handler.handle(msg.Body ?? "", {
          onEnvelope: (messageId, correlationId) => enrichLogContext({ messageId, correlationId, causationId: messageId }),
        });
      } catch (err) {
        outcome = { action: "retry", reason: `UNEXPECTED: ${String(err).slice(0, 120)}` };
      }

      if (outcome.action === "ack") {
        await this.failpoints.hit("consumer.after_commit_before_ack");
        if (outcome.note === "inbox_duplicate") this.log("info", "inbox duplicate", fields);
        try {
          await this.sqs.send(new DeleteMessageCommand({ QueueUrl: await this.queueUrl(), ReceiptHandle: receipt }));
        } catch (err) {
          // the effect is committed; the message will come back and the inbox will absorb it
          this.log("warn", "delete after commit failed; redelivery will be deduplicated", { ...fields, err: String(err) });
        }
        return true;
      }

      if (outcome.action === "retry" && receiveCount < this.cfg.maxReceiveCount) {
        const ceiling = Math.min(this.cfg.retryMaxMs, this.cfg.retryBaseMs * 2 ** (receiveCount - 1));
        const delayS = Math.round((this.random() * ceiling) / 1000); // full jitter
        await this.sqs.send(
          new ChangeMessageVisibilityCommand({ QueueUrl: await this.queueUrl(), ReceiptHandle: receipt, VisibilityTimeout: delayS }),
        );
        this.metrics.sqsRetries.inc();
        this.log("warn", "message will be retried", { ...fields, reason: outcome.reason, delayS });
        return false;
      }

      const reason = outcome.action === "dlq" ? outcome.reason : "RETRY_LIMIT_EXCEEDED";
      await this.deadLetter(msg, receiveCount, reason, outcome.reason);
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: await this.queueUrl(), ReceiptHandle: receipt }));
      this.metrics.sqsDlq.inc({ reason });
      this.log("error", "message sent to DLQ", { ...fields, reason, detail: outcome.reason });
      return false;
    } finally {
      this.held.delete(sqsId);
    }
  }

  private async deadLetter(msg: Message, receiveCount: number, reason: string, detail: string): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: await this.queues.url(this.cfg.dlqName),
        MessageBody: msg.Body ?? "",
        MessageGroupId: msg.Attributes?.MessageGroupId ?? "unknown",
        MessageDeduplicationId: `dlq-${msg.MessageId}`, // idempotent if the delete fails and it comes back
        MessageAttributes: {
          failureReason: { DataType: "String", StringValue: reason },
          failureDetail: { DataType: "String", StringValue: detail.slice(0, 256) || reason },
          receiveCount: { DataType: "Number", StringValue: String(receiveCount) },
        },
      }),
    );
  }

  private async release(receipt: string): Promise<void> {
    await this.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: await this.queueUrl(), ReceiptHandle: receipt, VisibilityTimeout: 0 }));
  }

  private async releaseAll(messages: Message[]): Promise<void> {
    await Promise.allSettled(messages.map((m) => this.release(m.ReceiptHandle!)));
  }
}
