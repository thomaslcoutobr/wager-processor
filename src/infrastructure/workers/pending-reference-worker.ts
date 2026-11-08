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
 * A transient failure (wallet busy, database down) backs the whole WALLET off in this instance, with
 * the same exponential schedule as the pending itself: the rest of that wallet's candidates are
 * skipped in the pass, and the next passes leave the wallet out of the query. So a busy wallet costs
 * at most one lock_timeout per pass, however many pendings it has, and the pending reversals of other
 * wallets still get into the batch. Backing off one candidate at a time was not enough: with a real
 * clock the pass (one lock_timeout per busy candidate) outlasted the back-off, and a wallet with more
 * pendings than the batch filled it again (R2b-01). The back-off lives in memory on purpose: writing
 * it would be a write without the wallet lock, which the design never does.
 */
export class PendingReferenceWorker {
  private readonly loop: PollingLoop;
  /** walletId → transient failures in a row and the time (clock ms) before which it is left out */
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
    const failedThisPass = new Set<string>();
    for (const c of due) {
      if (stopping()) break; // SIGTERM: the rest stays due for the next instance
      if (failedThisPass.has(c.walletId)) {
        // the wallet just failed transiently: trying its other candidates now would only wait again
        counts.skipped = (counts.skipped ?? 0) + 1;
        continue;
      }
      let outcome: string;
      try {
        outcome = await withLogContext({ transactionId: c.id, walletId: c.walletId, causationId: c.id }, () =>
          this.resolve.execute(c.id, c.walletId),
        );
        this.backoff.delete(c.walletId);
      } catch (err) {
        if (err instanceof DatabaseInvariantError) {
          // retrying a decision the schema refuses would loop forever: record it as FAILED
          await this.resolve.markFailed(c.id, c.walletId);
          this.log("error", "pending transaction failed permanently", { transactionId: c.id, walletId: c.walletId, sqlstate: err.sqlstate });
          outcome = "failed";
        } else {
          // transient: the row is untouched; this instance leaves the wallet out for a while
          const failures = (this.backoff.get(c.walletId)?.failures ?? 0) + 1;
          const untilMs = this.policy.nextAttemptAt(this.clock.now(), failures - 1, this.random).getTime();
          this.backoff.set(c.walletId, { failures, untilMs });
          failedThisPass.add(c.walletId);
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
   * Wallets still inside their back-off. An entry is forgotten one max delay after it ends (the wallet
   * was freed, or its pendings were decided elsewhere), so the map stays as small as the trouble.
   */
  private backedOff(nowMs: number): string[] {
    const ids: string[] = [];
    for (const [walletId, b] of this.backoff) {
      if (b.untilMs > nowMs) ids.push(walletId);
      else if (b.untilMs + this.policy.maxDelayMs < nowMs) this.backoff.delete(walletId);
    }
    return ids;
  }
}
