import type { FailureCode } from "../../domain/failure-code";
import { InboxMessage } from "../../domain/inbox-message";
import { type LedgerDirection, WalletLedgerEntry } from "../../domain/ledger-entry";
import { Money } from "../../domain/money";
import type { OutboxMessage } from "../../domain/outbox-message";
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from "../../domain/wager-transaction";
import { Wallet } from "../../domain/wallet";

/** Shapes of what MikroORM hands back / accepts. Money columns are strings with scale 2. */
export interface WalletRow {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface TransactionRow {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  resultBalance: string | null;
  attempts: number;
  nextAttemptAt: Date | null;
  pendingDeadlineAt: Date | null;
  createdAt: Date;
  processedAt: Date | null;
}

export interface LedgerRow {
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  walletVersion: number;
  createdAt: Date;
}

const money = (amount: string, currency: string) => Money.from({ amount, currency });
const opt = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);
const nul = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

export const walletMapper = {
  toDomain(r: WalletRow): Wallet {
    return Wallet.rehydrate({
      id: r.id,
      playerId: r.playerId,
      currency: r.currency,
      balance: money(r.balance, r.currency),
      version: r.version,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    });
  },
  toRow(w: Wallet): WalletRow {
    return {
      id: w.id,
      playerId: w.playerId,
      currency: w.currency,
      balance: w.balance.amount,
      version: w.version,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    };
  },
};

export const transactionMapper = {
  toDomain(r: TransactionRow): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: r.id,
      providerId: r.providerId,
      externalTransactionId: r.externalTransactionId,
      idempotencyKey: r.idempotencyKey,
      payloadHash: r.payloadHash,
      walletId: r.walletId,
      playerId: r.playerId,
      roundId: opt(r.roundId),
      gameId: opt(r.gameId),
      kind: r.kind as WagerTransactionKind,
      money: money(r.amount, r.currency),
      referenceExternalTransactionId: opt(r.referenceExternalTransactionId),
      referenceTransactionId: opt(r.referenceTransactionId),
      status: r.status as WagerTransactionStatus,
      failureCode: opt(r.failureCode) as FailureCode | undefined,
      resultBalance: r.resultBalance === null ? undefined : money(r.resultBalance, r.currency),
      attempts: r.attempts,
      nextAttemptAt: opt(r.nextAttemptAt),
      pendingDeadlineAt: opt(r.pendingDeadlineAt),
      createdAt: r.createdAt,
      processedAt: opt(r.processedAt),
    });
  },
  toRow(tx: WagerTransaction): TransactionRow {
    const s = tx.toState();
    return {
      id: s.id,
      providerId: s.providerId,
      externalTransactionId: s.externalTransactionId,
      idempotencyKey: s.idempotencyKey,
      payloadHash: s.payloadHash,
      walletId: s.walletId,
      playerId: s.playerId,
      roundId: nul(s.roundId),
      gameId: nul(s.gameId),
      kind: s.kind,
      amount: s.money.amount,
      currency: s.money.currency,
      referenceExternalTransactionId: nul(s.referenceExternalTransactionId),
      referenceTransactionId: nul(s.referenceTransactionId),
      status: s.status,
      failureCode: nul(s.failureCode),
      resultBalance: s.resultBalance ? s.resultBalance.amount : null,
      attempts: s.attempts,
      nextAttemptAt: nul(s.nextAttemptAt),
      pendingDeadlineAt: nul(s.pendingDeadlineAt),
      createdAt: s.createdAt,
      processedAt: nul(s.processedAt),
    };
  },
  /** Columns a transition may change (the trigger refuses anything else). */
  mutableColumns(tx: WagerTransaction) {
    const r = transactionMapper.toRow(tx);
    return {
      status: r.status,
      failureCode: r.failureCode,
      referenceTransactionId: r.referenceTransactionId,
      resultBalance: r.resultBalance,
      attempts: r.attempts,
      nextAttemptAt: r.nextAttemptAt,
      pendingDeadlineAt: r.pendingDeadlineAt,
      processedAt: r.processedAt,
    };
  },
};

export const ledgerMapper = {
  toDomain(r: LedgerRow): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: r.id,
      walletId: r.walletId,
      transactionId: r.transactionId,
      direction: r.direction as LedgerDirection,
      money: money(r.amount, r.currency),
      balanceBefore: money(r.balanceBefore, r.currency),
      balanceAfter: money(r.balanceAfter, r.currency),
      walletVersion: r.walletVersion,
      createdAt: r.createdAt,
    });
  },
  toRow(e: WalletLedgerEntry): LedgerRow {
    return {
      id: e.id,
      walletId: e.walletId,
      transactionId: e.transactionId,
      direction: e.direction,
      amount: e.money.amount,
      currency: e.money.currency,
      balanceBefore: e.balanceBefore.amount,
      balanceAfter: e.balanceAfter.amount,
      walletVersion: e.walletVersion,
      createdAt: e.createdAt,
    };
  },
};

export const inboxMapper = {
  toDomain(r: { consumerName: string; messageId: string; payloadHash: string; receivedAt: Date; processedAt: Date | null }) {
    return InboxMessage.rehydrate({ ...r, processedAt: opt(r.processedAt) });
  },
};

export const outboxMapper = {
  toRow(m: OutboxMessage) {
    const s = m.toState();
    return {
      id: s.id,
      aggregateId: s.aggregateId,
      messageGroupId: s.messageGroupId,
      eventType: s.eventType,
      eventVersion: s.eventVersion,
      payload: s.payload as Record<string, unknown>,
      occurredAt: s.occurredAt,
      attempts: s.attempts,
      nextAttemptAt: s.nextAttemptAt,
      publishedAt: nul(s.publishedAt),
      lastError: nul(s.lastError),
    };
  },
};
