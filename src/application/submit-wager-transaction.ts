import type { ConflictCode } from "../domain/failure-code";
import { InboxMessage } from "../domain/inbox-message";
import type { PendingReferencePolicy } from "../domain/pending-reference-policy";
import { WagerSettlement } from "../domain/wager-settlement";
import { WagerTransaction, WagerTransactionStatus as S } from "../domain/wager-transaction";
import { RetryableConflictError, TransientError, UniqueViolationError } from "./errors";
import { outboxFor } from "./event-factory";
import { payloadHashOf } from "./payload-hash";
import type { Clock, IdGenerator, Metrics, ReadStore, RequestContext, TransactionalStore, UnitOfWork } from "./ports";
import { nudgeDependents } from "./resolve-pending-reference";
import type { SubmitWagerCommand } from "./wager-command";

export type SubmitResult =
  | { type: "decided"; transaction: WagerTransaction; replay: boolean }
  | { type: "conflict"; code: Extract<ConflictCode, "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH" | "EXTERNAL_TRANSACTION_ID_CONFLICT">; transactionId: string }
  | { type: "wallet_not_found" }
  | { type: "inbox_duplicate" }
  | { type: "inbox_conflict" };

export interface InboxRef {
  consumerName: string;
  messageId: string;
}

/** Thrown inside the unit of work to roll back (e.g. the inbox row) while still returning a result. */
class Rollback extends Error {
  constructor(readonly result: SubmitResult) {
    super("rollback");
  }
}

const MAX_CONFLICT_RETRIES = 3;

/**
 * The single decision path for HTTP and SQS (ARCHITECTURE §9):
 *  0. fast path outside any transaction: known idempotency key → replay or 409
 *  1. BEGIN; lock_timeout            2. SELECT wallet FOR UPDATE (first statement)
 *  3. [SQS] inbox ON CONFLICT DO NOTHING
 *  4. re-read by key OR external id (sees whatever committed while we waited for the lock)
 *  5. reference + "already reversed"  6. WagerSettlement.decide (pure domain)
 *  7. plain INSERT of the transaction 8. wallet UPDATE … WHERE version + ledger INSERT
 *  9. outbox                         10. nudge pending transactions waiting for this one (final outcomes)
 * 11. COMMIT (deferred triggers re-check balance ↔ ledger)
 * A 23505 aborts the transaction and the whole use case runs once more, so the re-read classifies it.
 */
export class SubmitWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly read: ReadStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly policy: PendingReferencePolicy,
    private readonly metrics: Metrics,
    private readonly random: () => number = Math.random,
  ) {}

  async execute(command: SubmitWagerCommand, ctx: RequestContext, inbox?: InboxRef): Promise<SubmitResult> {
    const started = performance.now();
    const hash = payloadHashOf(command);
    let uniqueRetried = false;
    let conflictRetries = 0;
    try {
      for (;;) {
        try {
          const result = await this.once(command, hash, ctx, inbox);
          this.report(result, command, ctx);
          return result;
        } catch (err) {
          if (err instanceof UniqueViolationError && !uniqueRetried) {
            uniqueRetried = true;
            this.metrics.dbRetry("unique_violation");
            continue;
          }
          if (err instanceof RetryableConflictError) {
            if (conflictRetries < MAX_CONFLICT_RETRIES) {
              conflictRetries++;
              this.metrics.dbRetry(err.sqlstate);
              await new Promise((r) => setTimeout(r, Math.round(10 * 2 ** conflictRetries * this.random())));
              continue;
            }
            throw new TransientError("CONCURRENCY_RETRY_EXHAUSTED", "too much contention on this wallet", err.sqlstate, { cause: err });
          }
          throw err;
        }
      }
    } finally {
      this.metrics.processingSeconds(ctx.source, (performance.now() - started) / 1000);
    }
  }

  private async once(command: SubmitWagerCommand, hash: string, ctx: RequestContext, inbox?: InboxRef): Promise<SubmitResult> {
    // 0. late retries never touch the wallet lock. On the queue path the inbox answers first:
    //    a redelivery of the same message is recognized by (consumerName, messageId), as it should.
    if (inbox) {
      const seen = await this.read.findInbox(inbox.consumerName, inbox.messageId);
      if (seen) return seen.matchesPayload(hash) ? { type: "inbox_duplicate" } : { type: "inbox_conflict" };
    }
    const known = await this.read.findTransactionByKey(command.providerId, command.idempotencyKey);
    if (known) return this.classify([known], command, hash);

    try {
      return await this.uow.run((store) => this.decide(store, command, hash, ctx, inbox));
    } catch (err) {
      if (err instanceof Rollback) return err.result;
      throw err;
    }
  }

  private async decide(
    store: TransactionalStore,
    command: SubmitWagerCommand,
    hash: string,
    ctx: RequestContext,
    inbox?: InboxRef,
  ): Promise<SubmitResult> {
    const now = this.clock.now();

    // 2. the wallet lock is always the first lock of the transaction (no lock-order cycles)
    const wallet = await store.lockWallet(command.walletId);
    if (!wallet) return { type: "wallet_not_found" };

    // 3. inbox (queue entry only)
    if (inbox) {
      const message = InboxMessage.receive({ consumerName: inbox.consumerName, messageId: inbox.messageId, payloadHash: hash, at: now });
      message.markProcessed(now);
      const existing = await store.insertInbox(message);
      if (existing) return existing.matchesPayload(hash) ? { type: "inbox_duplicate" } : { type: "inbox_conflict" };
    }

    // 4. the burst decider: runs after the lock, so it sees the commit of whoever held it before us
    const found = await store.findTransactionsByKeyOrExternalId(command.providerId, command.idempotencyKey, command.externalTransactionId);
    if (found.length > 0) {
      const result = this.classify(found, command, hash);
      if (result.type === "conflict" && inbox) throw new Rollback(result); // do not keep the inbox row
      return result;
    }

    // 5. reference
    const reference = command.referenceExternalTransactionId
      ? await store.findTransactionByExternalId(command.providerId, command.referenceExternalTransactionId)
      : undefined;
    const referenceAlreadyReversed = reference ? await store.isReversed(reference.id) : false;

    // 6. pure decision
    const transaction = WagerTransaction.create({
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: hash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: now,
    });
    const versionBefore = wallet.version;
    const outcome = WagerSettlement.decide({
      wallet,
      transaction,
      reference,
      referenceAlreadyReversed,
      now,
      entryId: this.ids.next(),
      policy: this.policy,
      random: this.random,
    });

    // 7-10. persist everything in this same transaction
    await store.insertTransaction(transaction);
    const entry = outcome.status === S.Processed ? outcome.entry : undefined;
    if (entry) {
      await store.updateWallet(wallet, versionBefore);
      await store.insertLedgerEntry(entry);
    }
    await store.insertOutbox(
      outboxFor({ transaction, wallet, entry, enteredPending: transaction.status === S.PendingReference, ctx, now }, this.ids),
    );
    await nudgeDependents(store, transaction, now);
    return { type: "decided", transaction, replay: false };
  }

  /** Same key + same hash → replay; same key + other hash → 409; other key, same external id → replay or 409. */
  private classify(found: WagerTransaction[], command: SubmitWagerCommand, hash: string): SubmitResult {
    const byKey = found.find((t) => t.idempotencyKey === command.idempotencyKey);
    const existing = byKey ?? found[0]!;
    if (existing.matchesPayload(hash)) return { type: "decided", transaction: existing, replay: true };
    return {
      type: "conflict",
      code: byKey ? "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH" : "EXTERNAL_TRANSACTION_ID_CONFLICT",
      transactionId: existing.id,
    };
  }

  private report(result: SubmitResult, command: SubmitWagerCommand, ctx: RequestContext): void {
    if (result.type === "decided" && !result.replay) {
      this.metrics.transactionDecided(result.transaction.status, command.kind, ctx.source);
    } else if (result.type === "decided") {
      this.metrics.duplicateDetected(ctx.source, "idempotency");
    } else if (result.type === "inbox_duplicate") {
      this.metrics.duplicateDetected(ctx.source, "inbox");
    }
  }
}
