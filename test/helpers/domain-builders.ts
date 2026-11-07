import { randomUUID } from "node:crypto";
import { Money } from "../../src/domain/money";
import { Wallet } from "../../src/domain/wallet";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerTransactionState,
} from "../../src/domain/wager-transaction";

export const T0 = new Date("2026-11-07T12:00:00.000Z");

export function brl(amount: string): Money {
  return Money.from({ amount, currency: "BRL" });
}

export function usd(amount: string): Money {
  return Money.from({ amount, currency: "USD" });
}

export function openWallet(balance: string, playerId = "player-1"): Wallet {
  const { wallet } = Wallet.open({
    id: randomUUID(),
    playerId,
    initialBalance: brl(balance),
    at: T0,
    openingTransactionId: randomUUID(),
    openingEntryId: randomUUID(),
  });
  return wallet;
}

export interface TxOverrides {
  kind?: WagerTransactionKind;
  amount?: string;
  money?: Money;
  externalTransactionId?: string;
  referenceExternalTransactionId?: string;
  roundId?: string;
  playerId?: string;
  providerId?: string;
}

/** A fresh PENDING transaction aimed at `wallet`. */
export function pendingTx(wallet: Wallet, o: TxOverrides = {}): WagerTransaction {
  const ext = o.externalTransactionId ?? `tx-${randomUUID()}`;
  return WagerTransaction.create({
    id: randomUUID(),
    providerId: o.providerId ?? "provider-a",
    externalTransactionId: ext,
    idempotencyKey: `provider-a:${ext}`,
    payloadHash: "v1:sha256:test",
    walletId: wallet.id,
    playerId: o.playerId ?? wallet.playerId,
    roundId: o.roundId ?? "round-1",
    gameId: "game-1",
    kind: o.kind ?? WagerTransactionKind.Bet,
    money: o.money ?? brl(o.amount ?? "10.00"),
    referenceExternalTransactionId: o.referenceExternalTransactionId,
    createdAt: T0,
  });
}

/** An already persisted transaction in any status (rehydrate skips transition rules). */
export function storedTx(
  wallet: Wallet,
  o: TxOverrides & { status?: WagerTransactionStatus; walletId?: string } = {},
): WagerTransaction {
  const base = pendingTx(wallet, o).toState();
  const status = o.status ?? WagerTransactionStatus.Processed;
  const terminal = status !== WagerTransactionStatus.PendingReference;
  const state: WagerTransactionState = {
    ...base,
    walletId: o.walletId ?? base.walletId,
    status,
    resultBalance: wallet.balance,
    failureCode:
      status === WagerTransactionStatus.Rejected
        ? "INSUFFICIENT_FUNDS"
        : status === WagerTransactionStatus.Failed
          ? "PROCESSING_FAILED"
          : undefined,
    processedAt: terminal ? T0 : undefined,
    nextAttemptAt: terminal ? undefined : T0,
    pendingDeadlineAt: terminal ? undefined : new Date(T0.getTime() + 600_000),
  };
  return WagerTransaction.rehydrate(state);
}
