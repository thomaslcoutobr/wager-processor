import { DatabaseInvariantError } from "../../application/errors";
import { withLogContext } from "../../application/log-context";
import type { Clock, ReadStore } from "../../application/ports";
import type { ResolvePendingReference } from "../../application/resolve-pending-reference";
import type { PendingReferencePolicy } from "../../domain/pending-reference-policy";
import type { PromMetrics } from "../observability/metrics";
import { PollingLoop } from "./polling-loop";

export type WorkerLogger = (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;

/**
 * Scheduled worker for PENDING_REFERENCE (runs in every instance). It reads due candidates without
 * locking; each candidate is decided in its own transaction that locks the wallet first.
 *
 * A transient failure (wallet busy, database down) backs the candidate off in this instance, with
 * the same exponential schedule as the pending itself, and the next passes leave it out of the
 * query. Without that, the same busy candidates would come first in every pass and fill the batch,
 * and the pending reversals of other wallets would never be tried. The back-off lives in memory on
 * purpose: writing it would be a write without the wallet lock, which the design never does.
 */
export class PendingReferenceWorker {
  private readonly loop: PollingLoop;
  /** transactionId → transient failures in a row and the time (clock ms) before which it is left out */
  private readonly backoff = new Map<string, { failures: number; untilMs: number }>();

  constructor(
    private readonly read: ReadStore,
    private readonly resolve: ResolvePendingReference,
    private readonly clock: Clock,
    private readonly metrics: PromMetrics,
    private readonly opts: { pollMs: number; batchSize: number },
    private readonly log: WorkerLogger,
    private readonly policy: PendingReferencePolicy,
    private readonly random: () => number = Math.random,
  ) {
    this.loop = new PollingLoop(opts.pollMs, (stopping) => this.runOnce(stopping).then(() => undefined), (err) =>
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
  async runOnce(stopping: () => boolean = () => false): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    const now = this.clock.now();
    const due = await this.read.findDuePending(now, this.opts.batchSize, this.backedOff(now.getTime()));
    for (const c of due) {
      if (stopping()) break; // SIGTERM: the rest stays due for the next instance
      let outcome: string;
      try {
        outcome = await withLogContext({ transactionId: c.id, walletId: c.walletId, causationId: c.id }, () =>
          this.resolve.execute(c.id, c.walletId),
        );
        this.backoff.delete(c.id);
      } catch (err) {
        if (err instanceof DatabaseInvariantError) {
          // retrying a decision the schema refuses would loop forever: record it as FAILED
          await this.resolve.markFailed(c.id, c.walletId);
          this.backoff.delete(c.id);
          this.log("error", "pending transaction failed permanently", { transactionId: c.id, walletId: c.walletId, sqlstate: err.sqlstate });
          outcome = "failed";
        } else {
          // transient: the row is untouched; this instance leaves it out for a while
          const failures = (this.backoff.get(c.id)?.failures ?? 0) + 1;
          const untilMs = this.policy.nextAttemptAt(this.clock.now(), failures - 1, this.random).getTime();
          this.backoff.set(c.id, { failures, untilMs });
          this.log("warn", "pending transaction retry deferred", { transactionId: c.id, walletId: c.walletId, failures, err: String(err) });
          outcome = "error";
        }
      }
      counts[outcome] = (counts[outcome] ?? 0) + 1;
      this.metrics.pendingReference.inc({ outcome });
    }
    return counts;
  }

  /**
   * Ids still inside their back-off. An entry is forgotten one max delay after it ends (the candidate
   * was decided elsewhere, or simply recovered), so the map stays as small as the trouble.
   */
  private backedOff(nowMs: number): string[] {
    const ids: string[] = [];
    for (const [id, b] of this.backoff) {
      if (b.untilMs > nowMs) ids.push(id);
      else if (b.untilMs + this.policy.maxDelayMs < nowMs) this.backoff.delete(id);
    }
    return ids;
  }
}
