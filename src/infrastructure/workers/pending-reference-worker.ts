import { DatabaseInvariantError } from "../../application/errors";
import type { Clock, ReadStore } from "../../application/ports";
import type { ResolvePendingReference } from "../../application/resolve-pending-reference";
import type { PromMetrics } from "../observability/metrics";
import { PollingLoop } from "./polling-loop";

export type WorkerLogger = (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;

/**
 * Scheduled worker for PENDING_REFERENCE (runs in every instance). It reads due candidates without
 * locking; each candidate is decided in its own transaction that locks the wallet first.
 */
export class PendingReferenceWorker {
  private readonly loop: PollingLoop;

  constructor(
    private readonly read: ReadStore,
    private readonly resolve: ResolvePendingReference,
    private readonly clock: Clock,
    private readonly metrics: PromMetrics,
    private readonly opts: { pollMs: number; batchSize: number },
    private readonly log: WorkerLogger,
  ) {
    this.loop = new PollingLoop(opts.pollMs, () => this.runOnce().then(() => undefined), (err) =>
      this.log("error", "pending worker tick failed", { err: String(err) }),
    );
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }

  /** One pass over the due candidates. Exposed so tests can drive the worker deterministically. */
  async runOnce(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    const due = await this.read.findDuePending(this.clock.now(), this.opts.batchSize);
    for (const c of due) {
      let outcome: string;
      try {
        outcome = await this.resolve.execute(c.id, c.walletId);
      } catch (err) {
        if (err instanceof DatabaseInvariantError) {
          // retrying a decision the schema refuses would loop forever: record it as FAILED
          await this.resolve.markFailed(c.id, c.walletId);
          this.log("error", "pending transaction failed permanently", { transactionId: c.id, walletId: c.walletId, sqlstate: err.sqlstate });
          outcome = "failed";
        } else {
          // transient: the row is untouched and still due, the next tick retries it
          this.log("warn", "pending transaction retry deferred", { transactionId: c.id, walletId: c.walletId, err: String(err) });
          outcome = "error";
        }
      }
      counts[outcome] = (counts[outcome] ?? 0) + 1;
      this.metrics.pendingReference.inc({ outcome });
    }
    return counts;
  }
}
