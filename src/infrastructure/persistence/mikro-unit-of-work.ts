import { LockMode } from "@mikro-orm/core";
import type { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { InvariantViolationError } from "../../domain/errors";
import type { InboxMessage } from "../../domain/inbox-message";
import type { WalletLedgerEntry } from "../../domain/ledger-entry";
import { type WagerTransaction, WagerTransactionStatus } from "../../domain/wager-transaction";
import type { Wallet } from "../../domain/wallet";
import type { FailpointPort, Metrics, TransactionalStore, UnitOfWork, UnitOfWorkOptions } from "../../application/ports";
import { OutboxMessage } from "../../domain/outbox-message";
import { translateDbError } from "./db-errors";
import {
  inboxMapper,
  ledgerMapper,
  outboxMapper,
  type TransactionRow,
  transactionMapper,
  type WalletRow,
  walletMapper,
} from "./mappers";
import {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from "./schemas";

/**
 * One SQL transaction per `run`: fresh EntityManager fork (empty identity map), READ COMMITTED,
 * `SET LOCAL lock_timeout`, and the callback's `em` for every statement (never the pool directly,
 * which would grab another connection and starve the pool under load).
 */
export class MikroUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly lockTimeoutMs: number,
    private readonly metrics: Metrics,
    private readonly failpoints: FailpointPort,
  ) {}

  async run<T>(work: (store: TransactionalStore) => Promise<T>, options: UnitOfWorkOptions = {}): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        await em.execute(`set local lock_timeout = '${Math.trunc(this.lockTimeoutMs)}ms'`);
        if (options.statementTimeoutMs) {
          await em.execute(`set local statement_timeout = '${Math.trunc(options.statementTimeoutMs)}ms'`);
        }
        const result = await work(new MikroTransactionalStore(em, this.metrics));
        await this.failpoints.hit(`${options.name ?? "usecase"}.before_commit`);
        return result;
      });
    } catch (err) {
      const translated = translateDbError(err);
      const state = (translated as { sqlstate?: string }).sqlstate;
      if (state === "55P03" || state === "40P01" || state === "40001") this.metrics.lockConflict(state);
      throw translated;
    }
  }
}

class MikroTransactionalStore implements TransactionalStore {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: Metrics,
  ) {}

  async lockWallet(walletId: string): Promise<Wallet | undefined> {
    const started = performance.now();
    const row = await this.em.findOne(WalletRecord, { id: walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    this.metrics.lockWaitSeconds((performance.now() - started) / 1000);
    return row ? walletMapper.toDomain(row as unknown as WalletRow) : undefined;
  }

  async findWalletByPlayer(playerId: string, currency: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(WalletRecord, { playerId, currency });
    return row ? walletMapper.toDomain(row as unknown as WalletRow) : undefined;
  }

  async insertWallet(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletRecord, walletMapper.toRow(wallet));
  }

  async updateWallet(wallet: Wallet, expectedVersion: number): Promise<void> {
    const n = await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedVersion },
      { balance: wallet.balance.amount, version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (n !== 1) throw new InvariantViolationError(`wallet ${wallet.id} was not at version ${expectedVersion} under its own lock`);
  }

  async insertLedgerEntry(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntryRecord, ledgerMapper.toRow(entry));
  }

  async findTransactionsByKeyOrExternalId(providerId: string, idempotencyKey: string, externalId: string) {
    const rows = await this.em.find(WagerTransactionRecord, {
      providerId,
      $or: [{ idempotencyKey }, { externalTransactionId: externalId }],
    });
    return rows.map((r) => transactionMapper.toDomain(r as unknown as TransactionRow));
  }

  async findTransactionByExternalId(providerId: string, externalId: string) {
    const row = await this.em.findOne(WagerTransactionRecord, { providerId, externalTransactionId: externalId });
    return row ? transactionMapper.toDomain(row as unknown as TransactionRow) : undefined;
  }

  async findTransactionById(id: string) {
    const row = await this.em.findOne(WagerTransactionRecord, { id });
    return row ? transactionMapper.toDomain(row as unknown as TransactionRow) : undefined;
  }

  async isReversed(transactionId: string): Promise<boolean> {
    const n = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId: transactionId,
      kind: { $in: ["REFUND", "ROLLBACK"] },
      status: WagerTransactionStatus.Processed,
    });
    return n > 0;
  }

  async insertTransaction(tx: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionRecord, transactionMapper.toRow(tx));
  }

  async updateTransaction(tx: WagerTransaction, expectedStatus: WagerTransactionStatus): Promise<void> {
    const n = await this.em.nativeUpdate(
      WagerTransactionRecord,
      { id: tx.id, status: expectedStatus },
      transactionMapper.mutableColumns(tx),
    );
    if (n !== 1) throw new InvariantViolationError(`transaction ${tx.id} was not ${expectedStatus} under the wallet lock`);
  }

  async insertInbox(message: InboxMessage): Promise<InboxMessage | undefined> {
    const s = message.toState();
    const inserted = await this.em.execute<{ message_id: string }[]>(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       values (?, ?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [s.consumerName, s.messageId, s.payloadHash, s.receivedAt, s.processedAt ?? null],
    );
    if (inserted.length === 1) return undefined;
    const existing = await this.em.findOne(InboxMessageRecord, { consumerName: s.consumerName, messageId: s.messageId });
    if (!existing) throw new InvariantViolationError("inbox conflict without a stored row");
    return inboxMapper.toDomain(existing as never);
  }

  async insertOutbox(messages: OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(OutboxMessageRecord, messages.map((m) => outboxMapper.toRow(m)));
  }

  /**
   * Claims whole groups (wallets) in order, in two steps (ARCHITECTURE §13):
   *  1. the HEAD of each group, i.e. its oldest unpublished event, when due, FOR UPDATE SKIP LOCKED.
   *     A group whose head another publisher holds is skipped, and nobody can claim a later event of
   *     it: a later event is never a head while the head is unpublished.
   *  2. the unpublished events of the claimed groups, oldest first. The publisher stops a group at the
   *     first one that fails or is not due, so a group never publishes out of order.
   * SKIP LOCKED is right for a queue table, wrong for a wallet.
   */
  async claimDueOutbox(now: Date, limit: number): Promise<OutboxMessage[]> {
    const heads = await this.em.execute<{ message_group_id: string }[]>(
      `select o.message_group_id from outbox_messages o
        where o.published_at is null and o.next_attempt_at <= ?
          and not exists (select 1 from outbox_messages p
                           where p.message_group_id = o.message_group_id and p.published_at is null
                             and (p.occurred_at, p.id) < (o.occurred_at, o.id))
        order by o.next_attempt_at, o.id
        limit ?
        for update of o skip locked`,
      [now, limit],
    );
    if (heads.length === 0) return [];
    const rows = await this.em.find(
      OutboxMessageRecord,
      { messageGroupId: { $in: heads.map((h) => h.message_group_id) }, publishedAt: null },
      { lockMode: LockMode.PESSIMISTIC_WRITE, orderBy: { occurredAt: "asc", id: "asc" }, limit },
    );
    return rows.map((r) =>
      OutboxMessage.rehydrate({
        id: r.id,
        aggregateId: r.aggregateId,
        messageGroupId: r.messageGroupId,
        eventType: r.eventType,
        eventVersion: r.eventVersion,
        payload: r.payload,
        occurredAt: r.occurredAt,
        attempts: r.attempts,
        nextAttemptAt: r.nextAttemptAt,
        publishedAt: r.publishedAt ?? undefined,
        lastError: r.lastError ?? undefined,
      }),
    );
  }

  async saveOutboxProgress(message: OutboxMessage): Promise<void> {
    const row = outboxMapper.toRow(message);
    await this.em.nativeUpdate(
      OutboxMessageRecord,
      { id: message.id },
      { publishedAt: row.publishedAt, attempts: row.attempts, nextAttemptAt: row.nextAttemptAt, lastError: row.lastError },
    );
  }

  async nudgePendingReferences(walletId: string, providerId: string, externalId: string, now: Date): Promise<number> {
    return this.em.nativeUpdate(
      WagerTransactionRecord,
      { walletId, providerId, referenceExternalTransactionId: externalId, status: WagerTransactionStatus.PendingReference },
      { nextAttemptAt: now },
    );
  }
}
