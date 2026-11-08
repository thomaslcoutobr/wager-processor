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
  /** Receive loops per instance. Each one holds at most one message, so at most one DB transaction. */
  concurrency: number;
  retryBaseMs: number;
  retryMaxMs: number;
  shutdownGraceMs: number;
}

/** Pause between empty receives when the long poll is capped down to 0 s (short grace), so a loop never spins. */
const IDLE_SHORT_POLL_MS = 100;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

/**
 * Own SQS consumer (~200 lines) so the decisions under evaluation are visible (ARCHITECTURE §12):
 * N receive loops with ONE message per ReceiveMessage, ack only after COMMIT, three error classes,
 * retry by ChangeMessageVisibility with full jitter, DLQ with the reason, graceful drain on SIGTERM.
 *
 * One message per receive because SQS counts receives, not attempts: a batch brings the followers of
 * a group along and every hand-back adds to their ApproximateReceiveCount, so they could reach the
 * redrive limit without ever being tried. With one per receive, FIFO itself keeps the rest of the
 * group back while its head is in flight (also during the retry backoff), and the other loops keep
 * applying other wallets in parallel.
 */
export class SqsConsumer implements BackgroundJob {
  readonly name = "sqs-consumer";
  private stopping = false;
  /** Wakes loops sleeping between receives. It never cancels a receive (see stop()). */
  private wake = new AbortController();
  /** Cancels the receives still open when the grace runs out. */
  private hardStop = new AbortController();
  private loops: Promise<void>[] = [];
  private readonly held = new Map<string, string>(); // SQS MessageId → receipt handle

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
    if (this.loops.length) return;
    this.stopping = false;
    this.wake = new AbortController();
    this.hardStop = new AbortController();
    this.loops = Array.from({ length: this.cfg.concurrency }, () => this.receiveLoop());
  }

  /**
   * Graceful, like the reference consumers (bbc/sqs-consumer stops with `abort: false` by default):
   * no new receive leaves, the receives already open run to the end and hand back what they bring,
   * and the messages being processed get the grace. Aborting an open long poll does not stop the
   * server, which could still take a message for a request nobody reads (invisible for the whole
   * visibility timeout). Only when the grace runs out are the open receives cut and the messages in
   * processing handed back.
   */
  async stop(): Promise<void> {
    if (!this.loops.length) return;
    this.stopping = true;
    this.wake.abort();
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      Promise.allSettled(this.loops).then(() => true),
      new Promise<boolean>((resolve) => {
        graceTimer = setTimeout(() => resolve(false), this.cfg.shutdownGraceMs);
      }),
    ]).finally(() => clearTimeout(graceTimer)); // a pending timer would keep the event loop alive
    if (!drained) {
      this.hardStop.abort();
      this.log("warn", "shutdown grace exceeded, handing messages back", { held: this.held.size });
      await Promise.allSettled([...this.held.values()].map((r) => this.release(r)));
      // the handler still running must not commit after its message was handed back: leave now.
      // Postgres rolls the open transaction back when the connection drops.
      setTimeout(() => process.exit(1), 200).unref();
    }
    this.loops = [];
    this.log("info", "sqs consumer stopped", { drained });
  }

  private async queueUrl(): Promise<string> {
    return this.queues.url(this.cfg.queueName);
  }

  /** A long poll never outlives half of the grace, so an idle loop always ends inside it on SIGTERM. */
  private pollWaitS(): number {
    return Math.min(this.cfg.waitTimeS, Math.floor(this.cfg.shutdownGraceMs / 2000));
  }

  private async receiveLoop(): Promise<void> {
    const waitS = this.pollWaitS();
    let failures = 0;
    while (!this.stopping) {
      let msg: Message | undefined;
      try {
        const res = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: await this.queueUrl(),
            MaxNumberOfMessages: 1, // never more: see the class comment
            WaitTimeSeconds: waitS,
            VisibilityTimeout: this.cfg.visibilityTimeoutS,
            MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
          }),
          { abortSignal: this.hardStop.signal },
        );
        failures = 0;
        msg = res.Messages?.[0];
      } catch (err) {
        if (this.hardStop.signal.aborted) return; // cut at the end of the grace
        failures++;
        const wait = Math.min(30_000, 500 * 2 ** failures);
        this.log("error", "sqs receive failed", { err: String(err), retryInMs: wait });
        await sleep(wait, this.wake.signal);
        continue;
      }
      if (!msg) {
        if (waitS === 0) await sleep(IDLE_SHORT_POLL_MS, this.wake.signal);
        continue;
      }
      if (this.stopping) {
        // arrived while shutting down: hand it back at once so another instance takes it
        await this.release(msg.ReceiptHandle!).catch((err) =>
          this.log("warn", "hand-back on shutdown failed; it returns after the visibility timeout", { err: String(err) }),
        );
        return;
      }
      try {
        await this.processOne(msg);
      } catch (err) {
        // SQS refused the retry or DLQ call; the loop goes on and the message returns after its visibility timeout
        this.log("error", "message handling failed", { err: String(err) });
      }
    }
  }

  /** Runs in its own log context (messageId, correlationId…). */
  private processOne(msg: Message): Promise<void> {
    return withLogContext({ sqsMessageId: msg.MessageId }, () => this.processInContext(msg));
  }

  private async processInContext(msg: Message): Promise<void> {
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
        return;
      }

      if (outcome.action === "retry" && receiveCount < this.cfg.maxReceiveCount) {
        const ceiling = Math.min(this.cfg.retryMaxMs, this.cfg.retryBaseMs * 2 ** (receiveCount - 1));
        const delayS = Math.round((this.random() * ceiling) / 1000); // full jitter
        await this.sqs.send(
          new ChangeMessageVisibilityCommand({ QueueUrl: await this.queueUrl(), ReceiptHandle: receipt, VisibilityTimeout: delayS }),
        );
        this.metrics.sqsRetries.inc();
        this.log("warn", "message will be retried", { ...fields, reason: outcome.reason, delayS });
        return;
      }

      const reason = outcome.action === "dlq" ? outcome.reason : "RETRY_LIMIT_EXCEEDED";
      await this.deadLetter(msg, receiveCount, reason, outcome.reason);
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: await this.queueUrl(), ReceiptHandle: receipt }));
      this.metrics.sqsDlq.inc({ reason });
      this.log("error", "message sent to DLQ", { ...fields, reason, detail: outcome.reason });
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
}
