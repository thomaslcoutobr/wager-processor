import type { WalletLedgerEntry } from "../../domain/ledger-entry";
import { type WagerTransaction, WagerTransactionStatus as S } from "../../domain/wager-transaction";
import type { Wallet } from "../../domain/wallet";
import type { RetryHint } from "./problem";

export function walletView(w: Wallet) {
  return {
    id: w.id,
    playerId: w.playerId,
    balance: w.balance.toJSON(),
    version: w.version,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}

export function ledgerEntryView(e: WalletLedgerEntry) {
  return {
    id: e.id,
    transactionId: e.transactionId,
    direction: e.direction,
    money: e.money.toJSON(),
    balanceBefore: e.balanceBefore.toJSON(),
    balanceAfter: e.balanceAfter.toJSON(),
    walletVersion: e.walletVersion,
    createdAt: e.createdAt.toISOString(),
  };
}

/** Full view for GET (200 in any status). */
export function transactionView(t: WagerTransaction) {
  return {
    transactionId: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId ?? null,
    gameId: t.gameId ?? null,
    kind: t.kind,
    money: t.money.toJSON(),
    status: t.status,
    failureCode: t.failureCode ?? null,
    referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
    referenceTransactionId: t.referenceTransactionId ?? null,
    balance: t.resultBalance?.toJSON() ?? null,
    attempts: t.attempts,
    nextAttemptAt: t.nextAttemptAt?.toISOString() ?? null,
    pendingDeadlineAt: t.pendingDeadlineAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
    processedAt: t.processedAt?.toISOString() ?? null,
  };
}

export interface SubmitReply {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * ARCHITECTURE §10.2: 200 applied · 202 accepted and pending · 422 rejected by a business rule (final)
 * · 500 for a FAILED replay. A replay answers with the code of the CURRENT state.
 */
export function submitReply(t: WagerTransaction, replay: boolean): SubmitReply {
  const headers: Record<string, string> = {};
  if (replay) headers["Idempotent-Replayed"] = "true";
  const body: Record<string, unknown> = {
    transactionId: t.id,
    status: t.status,
    balance: t.resultBalance?.toJSON() ?? null,
    idempotentReplay: replay,
  };
  let status: number;
  let retry: RetryHint | undefined;
  switch (t.status) {
    case S.Processed:
      status = 200;
      break;
    case S.Rejected:
      status = 422;
      retry = "NEVER";
      break;
    case S.PendingReference:
      status = 202;
      retry = "POLL";
      headers.Location = `/wagering/transactions/${t.id}`;
      break;
    default:
      status = 500;
      retry = "NEVER";
  }
  if (t.failureCode) body.failureCode = t.failureCode;
  if (retry) body.retry = retry;
  return { status, headers, body };
}
