import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type EventContext,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../src/domain/events";
import { OutboxMessage } from "../../src/domain/outbox-message";
import { InboxMessage } from "../../src/domain/inbox-message";
import { InvalidStateError } from "../../src/domain/errors";
import { LedgerDirection } from "../../src/domain/ledger-entry";
import { WagerTransactionKind as K } from "../../src/domain/wager-transaction";
import { brl, openWallet, pendingTx, T0 } from "../helpers/domain-builders";

const ctx = (): EventContext => ({
  eventId: randomUUID(),
  correlationId: "corr-1",
  causationId: "msg-1",
  occurredAt: T0,
});

describe("IntegrationEvent envelope", () => {
  it("WalletBalanceChanged carries MoneyProps strings, walletVersion and a typed eventType", () => {
    const w = openWallet("100.00");
    const r = w.debit({ money: brl("25.00"), transactionId: randomUUID(), entryId: randomUUID(), at: T0 });
    if (!r.ok) throw new Error("unexpected");
    const c = ctx();
    const ev = WalletBalanceChanged.from(w, r.entry, c);
    const json = ev.toJSON();
    expect(json.eventType).toBe("WalletBalanceChanged");
    expect(json.version).toBe(1);
    expect(json.eventId).toBe(c.eventId);
    expect(json.aggregateId).toBe(w.id);
    expect(json.correlationId).toBe("corr-1");
    expect(json.causationId).toBe("msg-1");
    expect(json.occurredAt).toBe("2026-11-07T12:00:00.000Z");
    expect(json.data).toEqual({
      walletId: w.id,
      transactionId: r.entry.transactionId,
      direction: LedgerDirection.Debit,
      money: { amount: "25.00", currency: "BRL" },
      balanceBefore: { amount: "100.00", currency: "BRL" },
      balanceAfter: { amount: "75.00", currency: "BRL" },
      walletVersion: 2,
    });
    // stable JSON: round-trips without losing anything (no Money instances, no Dates)
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  it("transaction events expose status, failure code and balance as strings", () => {
    const w = openWallet("10.00");
    const tx = pendingTx(w, { kind: K.Bet, amount: "50.00" });
    tx.reject({ code: "INSUFFICIENT_FUNDS", resultBalance: w.balance, at: T0 });
    const json = WagerTransactionRejected.from(tx, ctx()).toJSON();
    expect(json.eventType).toBe("WagerTransactionRejected");
    expect(json.aggregateId).toBe(tx.id);
    expect(json.data.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(json.data.money).toEqual({ amount: "50.00", currency: "BRL" });
    expect(json.data.balance).toEqual({ amount: "10.00", currency: "BRL" });
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  it("processed and pending-reference events have their own types", () => {
    const w = openWallet("10.00");
    const ok = pendingTx(w, { kind: K.Loss });
    ok.markProcessed({ resultBalance: w.balance, at: T0 });
    expect(WagerTransactionProcessed.from(ok, ctx()).eventType).toBe("WagerTransactionProcessed");

    const pend = pendingTx(w, { kind: K.Refund, referenceExternalTransactionId: "b-1" });
    pend.markPendingReference({ resultBalance: w.balance, nextAttemptAt: T0, deadlineAt: T0 });
    const pj = WagerTransactionPendingReference.from(pend, ctx()).toJSON();
    expect(pj.eventType).toBe("WagerTransactionPendingReference");
    expect(pj.data.referenceExternalTransactionId).toBe("b-1");
  });

  it("events are immutable", () => {
    const w = openWallet("10.00");
    const tx = pendingTx(w, { kind: K.Loss });
    tx.markProcessed({ resultBalance: w.balance, at: T0 });
    const ev = WagerTransactionProcessed.from(tx, ctx());
    expect(Object.isFrozen(ev.data)).toBe(true);
  });
});

describe("OutboxMessage", () => {
  const event = () => {
    const w = openWallet("10.00");
    const tx = pendingTx(w, { kind: K.Loss });
    tx.markProcessed({ resultBalance: w.balance, at: T0 });
    return { ev: WagerTransactionProcessed.from(tx, ctx()), walletId: w.id };
  };

  it("enqueue stores the serialized envelope, keyed by eventId, grouped by wallet, due immediately", () => {
    const { ev, walletId } = event();
    const m = OutboxMessage.enqueue(ev, { messageGroupId: walletId });
    expect(m.id).toBe(ev.eventId);
    expect(m.eventType).toBe("WagerTransactionProcessed");
    expect(m.eventVersion).toBe(1);
    expect(m.messageGroupId).toBe(walletId);
    expect(m.payload).toEqual(ev.toJSON() as unknown as Record<string, unknown>);
    expect(m.attempts).toBe(0);
    expect(m.isPending()).toBe(true);
    expect(m.isDue(T0)).toBe(true);
    expect(m.isDue(new Date(T0.getTime() - 1))).toBe(false);
  });

  it("scheduleRetry increments attempts with capped exponential backoff and jitter", () => {
    const { ev, walletId } = event();
    const m = OutboxMessage.enqueue(ev, { messageGroupId: walletId });
    m.scheduleRetry(T0, "boom", () => 1);
    expect(m.attempts).toBe(1);
    expect(m.nextAttemptAt!.getTime() - T0.getTime()).toBe(2_000);
    expect(m.lastError).toBe("boom");
    m.scheduleRetry(T0, "boom", () => 0);
    expect(m.nextAttemptAt!.getTime() - T0.getTime()).toBe(2_000); // 4 s × 0.5
    for (let i = 0; i < 20; i++) m.scheduleRetry(T0, "boom", () => 1);
    expect(m.nextAttemptAt!.getTime() - T0.getTime()).toBe(300_000);
    expect(m.isPending()).toBe(true);
  });

  it("markPublished is terminal", () => {
    const { ev, walletId } = event();
    const m = OutboxMessage.enqueue(ev, { messageGroupId: walletId });
    m.markPublished(T0);
    expect(m.isPending()).toBe(false);
    expect(m.isDue(T0)).toBe(false);
    expect(() => m.markPublished(T0)).toThrow(InvalidStateError);
    expect(() => m.scheduleRetry(T0, "x")).toThrow(InvalidStateError);
  });
});

describe("InboxMessage", () => {
  it("receive → markProcessed, compares payload hash", () => {
    const m = InboxMessage.receive({ consumerName: "wager-tx", messageId: "msg-1", payloadHash: "h1", at: T0 });
    expect(m.isProcessed()).toBe(false);
    m.markProcessed(T0);
    expect(m.isProcessed()).toBe(true);
    expect(m.processedAt).toEqual(T0);
    expect(m.matchesPayload("h1")).toBe(true);
    expect(m.matchesPayload("h2")).toBe(false);
    expect(() => m.markProcessed(T0)).toThrow(InvalidStateError);
  });

  it("rehydrate rebuilds state", () => {
    const m = InboxMessage.rehydrate({
      consumerName: "c",
      messageId: "m",
      payloadHash: "h",
      receivedAt: T0,
      processedAt: T0,
    });
    expect(m.isProcessed()).toBe(true);
  });
});
