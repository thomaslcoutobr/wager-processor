import { InvalidTransactionStateError, InvariantViolationError } from "./errors";
import type { BusinessRejectionCode } from "./failure-code";
import type { WalletLedgerEntry } from "./ledger-entry";
import type { PendingReferencePolicy } from "./pending-reference-policy";
import {
  type WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from "./wager-transaction";
import type { Wallet } from "./wallet";

export interface SettlementInput {
  /** The wallet, already locked by the caller (SELECT … FOR UPDATE). */
  wallet: Wallet;
  /** PENDING (first decision) or PENDING_REFERENCE (worker re-run). */
  transaction: WagerTransaction;
  /** Resolved by (providerId, referenceExternalTransactionId); undefined when it does not exist (yet). */
  reference: WagerTransaction | undefined;
  /** Whether a PROCESSED REFUND/ROLLBACK already points at `reference`. */
  referenceAlreadyReversed: boolean;
  now: Date;
  /** Id for the ledger entry, if one is produced. */
  entryId: string;
  policy: PendingReferencePolicy;
  random?: () => number;
}

export type SettlementResult =
  | { status: S.Processed; entry: WalletLedgerEntry | undefined }
  | { status: S.Rejected; failureCode: BusinessRejectionCode }
  | { status: S.PendingReference; rescheduled: boolean };

/** Which kinds each kind may reference (rule 3, plus the optional BET reference of WIN and LOSS). */
const ALLOWED_REFERENCE: Readonly<Record<K, ReadonlySet<K>>> = {
  [K.Opening]: new Set(),
  [K.Bet]: new Set(),
  [K.Win]: new Set([K.Bet]),
  [K.Loss]: new Set([K.Bet]),
  [K.Refund]: new Set([K.Bet]),
  [K.Rollback]: new Set([K.Bet, K.Win, K.Refund]),
};

/**
 * The business rules of section 7 as one pure function (no I/O). It mutates the two aggregates it
 * is given (wallet balance/version and the transaction status) and returns the outcome; the caller
 * persists both plus the entry in a single SQL transaction.
 *
 * The check order is fixed so the same request always yields the same code (ARCHITECTURE §5):
 * currency → player → reference (exists, same wallet/player/currency/round, allowed kind,
 * processed, not reversed yet, same amount) → balance.
 */
export const WagerSettlement = {
  decide(input: SettlementInput): SettlementResult {
    const { wallet, transaction: tx, now, policy } = input;
    const random = input.random ?? Math.random;

    if (tx.isTerminal()) {
      throw new InvalidTransactionStateError(`transaction ${tx.id} is already ${tx.status}`);
    }
    if (tx.walletId !== wallet.id) {
      throw new InvariantViolationError("transaction and wallet do not match; the caller locked the wrong wallet");
    }

    const reject = (code: BusinessRejectionCode, referenceTransactionId?: string): SettlementResult => {
      tx.reject({ code, resultBalance: wallet.balance, at: now, referenceTransactionId });
      return { status: S.Rejected, failureCode: code };
    };

    const waitOrExpire = (codeWhenExpired: BusinessRejectionCode): SettlementResult => {
      if (tx.status === S.Pending) {
        tx.markPendingReference({
          resultBalance: wallet.balance,
          nextAttemptAt: policy.nextAttemptAt(now, 0, random),
          deadlineAt: policy.deadlineFrom(now),
        });
        return { status: S.PendingReference, rescheduled: false };
      }
      const deadline = tx.pendingDeadlineAt;
      if (!deadline) throw new InvariantViolationError(`pending transaction ${tx.id} has no deadline`);
      if (policy.isExpired(deadline, now)) return reject(codeWhenExpired);
      tx.scheduleRetry({ nextAttemptAt: policy.nextAttemptAt(now, tx.attempts + 1, random) });
      return { status: S.PendingReference, rescheduled: true };
    };

    // 1-2. the operation must target this wallet's currency and owner
    if (tx.money.currency !== wallet.currency) return reject("CURRENCY_MISMATCH");
    if (tx.playerId !== wallet.playerId) return reject("PLAYER_WALLET_MISMATCH");

    // 3. reference, when present
    let reference: WagerTransaction | undefined;
    if (tx.referenceExternalTransactionId !== undefined) {
      const ref = input.reference;
      if (!ref) return waitOrExpire("REFERENCE_NOT_FOUND");
      if (ref.providerId !== tx.providerId || ref.externalTransactionId !== tx.referenceExternalTransactionId) {
        throw new InvariantViolationError("the caller resolved a reference that is not the one requested");
      }
      if (
        ref.walletId !== tx.walletId ||
        ref.playerId !== tx.playerId ||
        ref.money.currency !== tx.money.currency ||
        ref.roundId !== tx.roundId
      ) {
        return reject("REFERENCE_MISMATCH", ref.id);
      }
      if (!ALLOWED_REFERENCE[tx.kind].has(ref.kind)) return reject("REFERENCE_KIND_NOT_ALLOWED", ref.id);
      if (ref.status === S.PendingReference) return waitOrExpire("REFERENCE_NOT_PROCESSED");
      if (ref.status !== S.Processed) return reject("REFERENCE_NOT_PROCESSED", ref.id);
      if (tx.requiresReference()) {
        if (input.referenceAlreadyReversed) return reject("ALREADY_REVERSED", ref.id);
        if (!tx.money.equals(ref.money)) return reject("AMOUNT_MISMATCH", ref.id);
      }
      reference = ref;
    }

    // 4. balance effect (LOSS and zero amounts have none, hence no entry and no version bump)
    let entry: WalletLedgerEntry | undefined;
    const direction = tx.ledgerDirectionFor(reference);
    if (direction !== undefined && tx.money.isPositive()) {
      const change = wallet.apply(direction, { money: tx.money, transactionId: tx.id, entryId: input.entryId, at: now });
      if (!change.ok) {
        return reject(tx.requiresReference() ? "REVERSAL_INSUFFICIENT_FUNDS" : "INSUFFICIENT_FUNDS", reference?.id);
      }
      entry = change.entry;
    }

    // 5. applied
    tx.markProcessed({ referenceTransactionId: reference?.id, resultBalance: wallet.balance, at: now });
    return { status: S.Processed, entry };
  },
};
