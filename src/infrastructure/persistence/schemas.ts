import { defineEntity, p } from "@mikro-orm/core";

/**
 * Persistence records (infrastructure only). The domain classes never see these; mappers translate.
 * Columns are created by the hand-written migration; these definitions only drive mapping.
 * numeric(20,2) columns are read and written as strings (never as JS numbers).
 */
export const WalletSchema = defineEntity({
  name: "WalletRecord",
  tableName: "wallets",
  properties: {
    id: p.uuid().primary(),
    playerId: p.text(),
    currency: p.string().length(3),
    balance: p.decimal().precision(20).scale(2),
    version: p.integer(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});
export class WalletRecord extends WalletSchema.class {}
WalletSchema.setClass(WalletRecord);

export const WagerTransactionSchema = defineEntity({
  name: "WagerTransactionRecord",
  tableName: "wager_transactions",
  properties: {
    id: p.uuid().primary(),
    providerId: p.text(),
    externalTransactionId: p.text(),
    idempotencyKey: p.text(),
    payloadHash: p.text(),
    walletId: p.uuid(),
    playerId: p.text(),
    roundId: p.text().nullable(),
    gameId: p.text().nullable(),
    kind: p.text(),
    amount: p.decimal().precision(20).scale(2),
    currency: p.string().length(3),
    referenceExternalTransactionId: p.text().nullable(),
    referenceTransactionId: p.uuid().nullable(),
    status: p.text(),
    failureCode: p.text().nullable(),
    resultBalance: p.decimal().precision(20).scale(2).nullable(),
    attempts: p.integer(),
    nextAttemptAt: p.datetime().nullable(),
    pendingDeadlineAt: p.datetime().nullable(),
    createdAt: p.datetime(),
    processedAt: p.datetime().nullable(),
  },
});
export class WagerTransactionRecord extends WagerTransactionSchema.class {}
WagerTransactionSchema.setClass(WagerTransactionRecord);

export const LedgerEntrySchema = defineEntity({
  name: "LedgerEntryRecord",
  tableName: "wallet_ledger_entries",
  properties: {
    id: p.uuid().primary(),
    walletId: p.uuid(),
    transactionId: p.uuid(),
    direction: p.text(),
    amount: p.decimal().precision(20).scale(2),
    currency: p.string().length(3),
    balanceBefore: p.decimal().precision(20).scale(2),
    balanceAfter: p.decimal().precision(20).scale(2),
    walletVersion: p.integer(),
    createdAt: p.datetime(),
  },
});
export class LedgerEntryRecord extends LedgerEntrySchema.class {}
LedgerEntrySchema.setClass(LedgerEntryRecord);

export const InboxMessageSchema = defineEntity({
  name: "InboxMessageRecord",
  tableName: "inbox_messages",
  properties: {
    consumerName: p.text().primary(),
    messageId: p.text().primary(),
    payloadHash: p.text(),
    receivedAt: p.datetime(),
    processedAt: p.datetime().nullable(),
  },
});
export class InboxMessageRecord extends InboxMessageSchema.class {}
InboxMessageSchema.setClass(InboxMessageRecord);

export const OutboxMessageSchema = defineEntity({
  name: "OutboxMessageRecord",
  tableName: "outbox_messages",
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.text(),
    messageGroupId: p.text(),
    eventType: p.text(),
    eventVersion: p.integer(),
    payload: p.json<Record<string, unknown>>(),
    occurredAt: p.datetime(),
    attempts: p.integer(),
    nextAttemptAt: p.datetime(),
    publishedAt: p.datetime().nullable(),
    lastError: p.text().nullable(),
  },
});
export class OutboxMessageRecord extends OutboxMessageSchema.class {}
OutboxMessageSchema.setClass(OutboxMessageRecord);

export const ALL_SCHEMAS = [WalletSchema, WagerTransactionSchema, LedgerEntrySchema, InboxMessageSchema, OutboxMessageSchema];
