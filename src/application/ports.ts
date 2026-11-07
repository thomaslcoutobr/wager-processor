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
}

export interface UnitOfWork {
  /** BEGIN (READ COMMITTED) + lock_timeout … COMMIT. Any throw rolls everything back. */
  run<T>(work: (store: TransactionalStore) => Promise<T>): Promise<T>;
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
}

export const noopMetrics: Metrics = {
  transactionDecided() {},
  duplicateDetected() {},
  dbRetry() {},
  lockConflict() {},
  lockWaitSeconds() {},
  processingSeconds() {},
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
