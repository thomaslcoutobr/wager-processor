import { Counter, Gauge, Histogram, Registry } from "prom-client";
import type { Metrics, Source } from "../../application/ports";

/**
 * Prometheus metrics (ARCHITECTURE §17). Low-cardinality labels only: never walletId or playerId.
 * One registry per app instance, so several in-process apps (tests) do not collide.
 */
export class PromMetrics implements Metrics {
  readonly registry = new Registry();

  readonly transactions = new Counter({
    name: "wager_transactions_total",
    help: "Wager transactions decided, by final status",
    labelNames: ["status", "kind", "source"] as const,
    registers: [this.registry],
  });
  readonly duplicates = new Counter({
    name: "wager_duplicates_total",
    help: "Duplicates detected (idempotency replay or inbox)",
    labelNames: ["source", "kind"] as const,
    registers: [this.registry],
  });
  readonly dbRetries = new Counter({
    name: "db_transaction_retries_total",
    help: "Use-case re-runs after a unique violation, deadlock or serialization failure",
    labelNames: ["reason"] as const,
    registers: [this.registry],
  });
  readonly lockConflicts = new Counter({
    name: "db_lock_conflicts_total",
    help: "Lock timeouts, deadlocks and serialization failures, by SQLSTATE",
    labelNames: ["sqlstate"] as const,
    registers: [this.registry],
  });
  readonly lockWait = new Histogram({
    name: "wallet_lock_wait_seconds",
    help: "Time until SELECT … FOR UPDATE on the wallet returned (contention shows up here, not as errors)",
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  readonly processing = new Histogram({
    name: "wager_processing_seconds",
    help: "End-to-end processing time of a wager transaction",
    labelNames: ["source"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });
  readonly sqsRetries = new Counter({
    name: "sqs_retries_total",
    help: "Messages returned to the queue with backoff after a transient failure",
    registers: [this.registry],
  });
  readonly sqsDlq = new Counter({
    name: "sqs_dlq_total",
    help: "Messages sent to the DLQ, by reason",
    labelNames: ["reason"] as const,
    registers: [this.registry],
  });
  readonly outboxPending = new Gauge({
    name: "outbox_pending",
    help: "Outbox rows not yet published",
    registers: [this.registry],
  });
  readonly outboxLag = new Gauge({
    name: "outbox_lag_seconds",
    help: "Age of the oldest unpublished outbox row",
    registers: [this.registry],
  });
  readonly outboxPublished = new Counter({
    name: "outbox_published_total",
    help: "Outbox rows published",
    registers: [this.registry],
  });
  readonly pendingReference = new Counter({
    name: "pending_reference_total",
    help: "Pending-reference worker outcomes",
    labelNames: ["outcome"] as const,
    registers: [this.registry],
  });
  readonly reconciliationDivergenceCounter = new Counter({
    name: "reconciliation_divergence_total",
    help: "Reconciliations that found stored balance != ledger",
    registers: [this.registry],
  });

  transactionDecided(status: string, kind: string, source: Source): void {
    this.transactions.inc({ status, kind, source });
  }
  duplicateDetected(source: Source, via: "idempotency" | "inbox"): void {
    this.duplicates.inc({ source, kind: via });
  }
  dbRetry(reason: string): void {
    this.dbRetries.inc({ reason });
  }
  lockConflict(sqlstate: string): void {
    this.lockConflicts.inc({ sqlstate });
  }
  lockWaitSeconds(seconds: number): void {
    this.lockWait.observe(seconds);
  }
  processingSeconds(source: Source, seconds: number): void {
    this.processing.observe({ source }, seconds);
  }
  reconciliationDivergence(): void {
    this.reconciliationDivergenceCounter.inc();
  }
}
