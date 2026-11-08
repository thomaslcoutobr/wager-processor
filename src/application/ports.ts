import type { InboxMessage } from "../domain/inbox-message";
import type { WalletLedgerEntry } from "../domain/ledger-entry";
import type { OutboxMessage } from "../domain/outbox-message";
import type { WagerTransaction, WagerTransactionStatus } from "../domain/wager-transaction";
import type { Wallet } from "../domain/wallet";

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** Time-ordered unique id (UUIDv7). */
  next(): string;
}

/**
 * Everything a use case can do inside ONE open SQL transaction. The implementation always uses the
 * transaction's own connection; the use case never sees the ORM.
 */
export interface TransactionalStore {
  /** SELECT … FOR UPDATE. Must be the first statement that touches business tables. */
  lockWallet(walletId: string): Promise<Wallet | undefined>;
  findWalletByPlayer(playerId: string, currency: string): Promise<Wallet | undefined>;
  insertWallet(wallet: Wallet): Promise<void>;
  /** UPDATE … WHERE version = expectedVersion; 0 rows is a bug and throws. */
  updateWallet(wallet: Wallet, expectedVersion: number): Promise<void>;
  insertLedgerEntry(entry: WalletLedgerEntry): Promise<void>;

  findTransactionsByKeyOrExternalId(providerId: string, idempotencyKey: string, externalId: string): Promise<WagerTransaction[]>;
  findTransactionByExternalId(providerId: string, externalId: string): Promise<WagerTransaction | undefined>;
  findTransactionById(id: string): Promise<WagerTransaction | undefined>;
  /** Whether a PROCESSED REFUND or ROLLBACK already points at this transaction. */
  isReversed(transactionId: string): Promise<boolean>;
  /** Plain INSERT (no ON CONFLICT): a unique violation aborts the whole transaction. */
  insertTransaction(tx: WagerTransaction): Promise<void>;
  /** UPDATE … WHERE status = expectedStatus; 0 rows is a bug and throws. */
  updateTransaction(tx: WagerTransaction, expectedStatus: WagerTransactionStatus): Promise<void>;

  /** INSERT … ON CONFLICT DO NOTHING. Returns the stored message when it already existed. */
  insertInbox(message: InboxMessage): Promise<InboxMessage | undefined>;
  insertOutbox(messages: OutboxMessage[]): Promise<void>;

  /** Pending transactions of this wallet waiting for (providerId, externalId) become due now. */
  nudgePendingReferences(walletId: string, providerId: string, externalId: string, now: Date): Promise<number>;

  /** SELECT … FOR UPDATE SKIP LOCKED: concurrent publishers get disjoint batches (queue table, never the wallet). */
  claimDueOutbox(now: Date, limit: number): Promise<OutboxMessage[]>;
  /** Persists published_at / attempts / next_attempt_at / last_error of a claimed row. */
  saveOutboxProgress(message: OutboxMessage): Promise<void>;
}

export interface UnitOfWorkOptions {
  /** Failpoint prefix: `<name>.before_commit` is hit right before COMMIT (default "usecase"). */
  name?: string;
  statementTimeoutMs?: number;
}

export interface UnitOfWork {
  /** BEGIN (READ COMMITTED) + lock_timeout … COMMIT. Any throw rolls everything back. */
  run<T>(work: (store: TransactionalStore) => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}

/** Where integration events go (wager-events.fifo). Must be idempotent on the message id. */
export interface EventBus {
  publish(message: OutboxMessage): Promise<void>;
  /** Reachability probe for readiness. */
  check(): Promise<void>;
}

/** Reads outside any transaction (each statement sees the latest committed state). */
export interface ReadStore {
  findWallet(walletId: string): Promise<Wallet | undefined>;
  findTransactionById(id: string): Promise<WagerTransaction | undefined>;
  findTransactionByExternalId(providerId: string, externalId: string): Promise<WagerTransaction | undefined>;
  findTransactionByKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined>;
  /** Newest first; `beforeVersion` excludes that version and everything newer. */
  listLedger(walletId: string, beforeVersion: number | undefined, limit: number): Promise<WalletLedgerEntry[]>;
  /** Candidates only (no lock): PENDING_REFERENCE rows whose next attempt is due. */
  findDuePending(now: Date, limit: number): Promise<Array<{ id: string; walletId: string }>>;
  findInbox(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  /**
   * One statement, one snapshot: stored balance, Σ ledger, entries checked and chain breaks
   * (before ≠ previous after, version gaps, first entry not from 0.00, last version ≠ wallet version).
   * Amounts as signed decimal strings (a tampered ledger can sum below zero).
   */
  reconcile(walletId: string): Promise<
    { currency: string; stored: string; calculated: string; checkedEntries: number; chainBreaks: number } | undefined
  >;
  /** Unpublished rows and the age of the oldest one (outbox lag). */
  outboxStats(now: Date): Promise<{ pending: number; oldestAgeSeconds: number }>;
}

export type Source = "http" | "sqs" | "worker" | "internal";

/** Observability port: the application reports facts, the infrastructure turns them into metrics. */
export interface Metrics {
  transactionDecided(status: string, kind: string, source: Source): void;
  duplicateDetected(source: Source, via: "idempotency" | "inbox"): void;
  dbRetry(reason: string): void;
  lockConflict(sqlstate: string): void;
  lockWaitSeconds(seconds: number): void;
  processingSeconds(source: Source, seconds: number): void;
  reconciliationDivergence(): void;
}

export const noopMetrics: Metrics = {
  transactionDecided() {},
  duplicateDetected() {},
  dbRetry() {},
  lockConflict() {},
  lockWaitSeconds() {},
  processingSeconds() {},
  reconciliationDivergence() {},
};

/** Named crash/fault injection points (no-op unless FAILPOINTS is set, never in production). */
export interface FailpointPort {
  hit(name: string): Promise<void>;
}

export const noFailpoints: FailpointPort = {
  async hit() {},
};

/** Correlation data that travels with a request or message into events and logs. */
export interface RequestContext {
  source: Source;
  correlationId: string;
  causationId?: string;
}
