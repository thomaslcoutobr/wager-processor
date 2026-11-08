import type { Clock, ReadStore } from "../../application/ports";
import type { PublishOutboxBatch } from "../../application/publish-outbox-batch";
import type { Logger } from "../observability/logger";
import type { PromMetrics } from "../observability/metrics";
import type { BackgroundJob } from "./background-jobs";
import { PollingLoop } from "./polling-loop";

/** Runs the outbox publisher in every instance and keeps outbox_pending / outbox_lag_seconds fresh. */
export class OutboxPublisherWorker implements BackgroundJob {
  readonly name = "outbox-publisher";
  private readonly loop: PollingLoop;

  constructor(
    private readonly publish: PublishOutboxBatch,
    private readonly read: ReadStore,
    private readonly clock: Clock,
    private readonly metrics: PromMetrics,
    private readonly opts: { pollMs: number; batchSize: number },
    private readonly log: Logger,
  ) {
    this.loop = new PollingLoop(opts.pollMs, (stopping) => this.tick(stopping), (err) => this.log("error", "outbox tick failed", { err: String(err) }));
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }

  /** One batch. Exposed so tests can drive publishers deterministically. */
  async runOnce(): Promise<number> {
    const published = await this.publish.execute();
    if (published > 0) this.metrics.outboxPublished.inc(published);
    await this.refreshStats();
    return published;
  }

  async refreshStats(): Promise<void> {
    const s = await this.read.outboxStats(this.clock.now());
    this.metrics.outboxPending.set(s.pending);
    this.metrics.outboxLag.set(s.oldestAgeSeconds);
  }

  /** Keeps going while batches come back full, so a backlog drains without waiting a poll per batch. */
  private async tick(stopping: () => boolean): Promise<void> {
    for (let i = 0; i < 50 && !stopping(); i++) {
      if ((await this.runOnce()) < this.opts.batchSize) return;
    }
  }
}
