import type { PendingReferencePolicy } from "../domain/pending-reference-policy";
import { WagerSettlement } from "../domain/wager-settlement";
import { type WagerTransaction, WagerTransactionStatus as Status } from "../domain/wager-transaction";
import { outboxFor } from "./event-factory";
import type { Clock, IdGenerator, Metrics, RequestContext, TransactionalStore, UnitOfWork } from "./ports";

export type ResolveOutcome = "processed" | "rejected" | "rescheduled" | "not_pending" | "failed";

/**
 * Re-decides one PENDING_REFERENCE transaction (ARCHITECTURE §14), through the very same
 * WagerSettlement.decide as the main path. Several instances may race on the same candidate:
 * the wallet lock serializes them and the loser re-reads a transaction that is no longer pending.
 */
export class ResolvePendingReference {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly policy: PendingReferencePolicy,
    private readonly metrics: Metrics,
    private readonly random: () => number = Math.random,
  ) {}

  async execute(transactionId: string, walletId: string): Promise<ResolveOutcome> {
    const ctx: RequestContext = { source: "worker", correlationId: this.ids.next(), causationId: transactionId };
    let kind = "unknown";
    const outcome = await this.uow.run(async (store) => {
      const wallet = await store.lockWallet(walletId); // always the first lock
      const now = this.clock.now(); // after the lock, like every decision (R1-05)
      const tx = await store.findTransactionById(transactionId);
      if (!wallet || !tx || tx.status !== Status.PendingReference) return "not_pending" as const;
      kind = tx.kind;

      const reference = await store.findTransactionByExternalId(tx.providerId, tx.referenceExternalTransactionId!);
      const referenceAlreadyReversed = reference ? await store.isReversed(reference.id) : false;
      const versionBefore = wallet.version;
      const result = WagerSettlement.decide({
        wallet,
        transaction: tx,
        reference,
        referenceAlreadyReversed,
        now,
        entryId: this.ids.next(),
        policy: this.policy,
        random: this.random,
      });

      await store.updateTransaction(tx, Status.PendingReference);
      const entry = result.status === Status.Processed ? result.entry : undefined;
      if (entry) {
        await store.updateWallet(wallet, versionBefore);
        await store.insertLedgerEntry(entry);
      }
      await store.insertOutbox(outboxFor({ transaction: tx, wallet, entry, enteredPending: false, ctx, now }, this.ids));
      await nudgeDependents(store, tx, now);
      if (result.status === Status.Processed) return "processed" as const;
      if (result.status === Status.Rejected) return "rejected" as const;
      return "rescheduled" as const;
    });
    if (outcome === "processed" || outcome === "rejected") {
      this.metrics.transactionDecided(outcome === "processed" ? Status.Processed : Status.Rejected, kind, "worker");
    }
    return outcome;
  }

  /** Permanent processing failure (the schema refused the decision): record FAILED so it stops retrying. */
  async markFailed(transactionId: string, walletId: string): Promise<boolean> {
    const ctx: RequestContext = { source: "worker", correlationId: this.ids.next(), causationId: transactionId };
    return this.uow.run(async (store) => {
      const wallet = await store.lockWallet(walletId);
      const now = this.clock.now();
      const tx = await store.findTransactionById(transactionId);
      if (!wallet || !tx || tx.status !== Status.PendingReference) return false;
      tx.fail({ code: "PROCESSING_FAILED", at: now });
      await store.updateTransaction(tx, Status.PendingReference);
      await store.insertOutbox(outboxFor({ transaction: tx, wallet, ctx, now }, this.ids));
      return true;
    });
  }
}

/**
 * When a transaction reaches a final outcome, the pending ones of the same wallet that wait for it
 * become due now ("nudge"): the common case resolves in the next worker cycle, still through the
 * single decision path. A REJECTED reference is nudged too, so its dependents fail fast.
 */
export async function nudgeDependents(store: TransactionalStore, tx: WagerTransaction, now: Date): Promise<void> {
  if (tx.status === Status.Processed || tx.status === Status.Rejected) {
    await store.nudgePendingReferences(tx.walletId, tx.providerId, tx.externalTransactionId, now);
  }
}
