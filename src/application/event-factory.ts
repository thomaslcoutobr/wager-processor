import {
  type EventContext,
  WagerTransactionFailed,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../domain/events";
import type { WalletLedgerEntry } from "../domain/ledger-entry";
import { OutboxMessage } from "../domain/outbox-message";
import { type WagerTransaction, WagerTransactionStatus as Status } from "../domain/wager-transaction";
import type { Wallet } from "../domain/wallet";
import type { IdGenerator, RequestContext } from "./ports";

/**
 * Outbox rows for one decision. Grouped by wallet so the events FIFO keeps per-wallet order.
 * PENDING_REFERENCE emits only when entering the state (`rescheduled` retries emit nothing).
 */
export function outboxFor(
  p: {
    transaction: WagerTransaction;
    wallet: Wallet;
    entry?: WalletLedgerEntry;
    enteredPending?: boolean;
    ctx: RequestContext;
    now: Date;
  },
  ids: IdGenerator,
): OutboxMessage[] {
  const context = (): EventContext => ({
    eventId: ids.next(),
    correlationId: p.ctx.correlationId,
    causationId: p.ctx.causationId,
    occurredAt: p.now,
  });
  const group = { messageGroupId: p.wallet.id };
  const tx = p.transaction;
  const out: OutboxMessage[] = [];
  switch (tx.status) {
    case Status.Processed:
      out.push(OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, context()), group));
      if (p.entry) out.push(OutboxMessage.enqueue(WalletBalanceChanged.from(p.wallet, p.entry, context()), group));
      break;
    case Status.Rejected:
      out.push(OutboxMessage.enqueue(WagerTransactionRejected.from(tx, context()), group));
      break;
    case Status.PendingReference:
      if (p.enteredPending) out.push(OutboxMessage.enqueue(WagerTransactionPendingReference.from(tx, context()), group));
      break;
    case Status.Failed:
      out.push(OutboxMessage.enqueue(WagerTransactionFailed.from(tx, context()), group));
      break;
    case Status.Pending:
      break;
  }
  return out;
}
