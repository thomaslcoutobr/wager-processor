import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { WagerSettlement, type SettlementResult } from "../../src/domain/wager-settlement";
import { PendingReferencePolicy } from "../../src/domain/pending-reference-policy";
import {
  type WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from "../../src/domain/wager-transaction";
import { LedgerDirection } from "../../src/domain/ledger-entry";
import type { Wallet } from "../../src/domain/wallet";
import { InvariantViolationError } from "../../src/domain/errors";
import { brl, openWallet, pendingTx, storedTx, T0, usd } from "../helpers/domain-builders";

const policy = PendingReferencePolicy.create({ ttlMs: 600_000, baseDelayMs: 1_000, maxDelayMs: 60_000 });
const NOW = new Date("2026-11-07T12:00:10.000Z");

function decide(
  wallet: Wallet,
  transaction: WagerTransaction,
  reference?: WagerTransaction,
  opts: { alreadyReversed?: boolean; now?: Date } = {},
): SettlementResult {
  return WagerSettlement.decide({
    wallet,
    transaction,
    reference,
    referenceAlreadyReversed: opts.alreadyReversed ?? false,
    now: opts.now ?? NOW,
    entryId: randomUUID(),
    policy,
    random: () => 1,
  });
}

describe("BET", () => {
  it("debits when there is balance", () => {
    const w = openWallet("100.00");
    const tx = pendingTx(w, { kind: K.Bet, amount: "25.00" });
    const r = decide(w, tx);
    expect(r.status).toBe(S.Processed);
    expect(r.status === S.Processed && r.entry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.toJSON().amount).toBe("75.00");
    expect(tx.status).toBe(S.Processed);
    expect(tx.resultBalance!.toJSON().amount).toBe("75.00");
    expect(tx.processedAt).toEqual(NOW);
  });

  it("is REJECTED INSUFFICIENT_FUNDS without balance, and nothing moves", () => {
    const w = openWallet("10.00");
    const tx = pendingTx(w, { kind: K.Bet, amount: "10.01" });
    const r = decide(w, tx);
    expect(r).toEqual({ status: S.Rejected, failureCode: "INSUFFICIENT_FUNDS" });
    expect(w.balance.toJSON().amount).toBe("10.00");
    expect(w.version).toBe(1);
    expect(tx.status).toBe(S.Rejected);
    expect(tx.resultBalance!.toJSON().amount).toBe("10.00");
  });

  it("section 8 scenario at domain level: 100.00 and two bets of 80.00 → one processed, one rejected, 20.00", () => {
    const w = openWallet("100.00");
    const a = decide(w, pendingTx(w, { amount: "80.00" }));
    const b = decide(w, pendingTx(w, { amount: "80.00" }));
    expect([a.status, b.status]).toEqual([S.Processed, S.Rejected]);
    expect(w.balance.toJSON().amount).toBe("20.00");
    expect(w.version).toBe(2);
  });

  it("zero amount is PROCESSED with no entry and no version bump", () => {
    const w = openWallet("5.00");
    const r = decide(w, pendingTx(w, { kind: K.Bet, amount: "0.00" }));
    expect(r).toEqual({ status: S.Processed, entry: undefined });
    expect(w.version).toBe(1);
  });
});

describe("WIN and LOSS", () => {
  it("WIN credits", () => {
    const w = openWallet("1.00");
    const r = decide(w, pendingTx(w, { kind: K.Win, amount: "50.00" }));
    expect(r.status === S.Processed && r.entry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.toJSON().amount).toBe("51.00");
  });

  it("LOSS is PROCESSED without entry and without moving the balance", () => {
    const w = openWallet("1.00");
    const tx = pendingTx(w, { kind: K.Loss, amount: "10.00" });
    const r = decide(w, tx);
    expect(r).toEqual({ status: S.Processed, entry: undefined });
    expect(w.balance.toJSON().amount).toBe("1.00");
    expect(w.version).toBe(1);
    expect(tx.status).toBe(S.Processed);
  });

  it("WIN with a valid BET reference is processed and links the reference", () => {
    const w = openWallet("100.00");
    const bet = storedTx(w, { kind: K.Bet, externalTransactionId: "bet-1" });
    const win = pendingTx(w, { kind: K.Win, amount: "30.00", referenceExternalTransactionId: "bet-1" });
    expect(decide(w, win, bet).status).toBe(S.Processed);
    expect(win.referenceTransactionId).toBe(bet.id);
  });

  it("WIN referencing a WIN is REFERENCE_KIND_NOT_ALLOWED", () => {
    const w = openWallet("100.00");
    const ref = storedTx(w, { kind: K.Win, externalTransactionId: "win-0" });
    const win = pendingTx(w, { kind: K.Win, referenceExternalTransactionId: "win-0" });
    expect(decide(w, win, ref)).toEqual({ status: S.Rejected, failureCode: "REFERENCE_KIND_NOT_ALLOWED" });
  });
});

describe("REFUND", () => {
  it("credits back a processed BET of the same amount", () => {
    const w = openWallet("75.00");
    const bet = storedTx(w, { kind: K.Bet, amount: "25.00", externalTransactionId: "bet-1" });
    const refund = pendingTx(w, { kind: K.Refund, amount: "25.00", referenceExternalTransactionId: "bet-1" });
    const r = decide(w, refund, bet);
    expect(r.status === S.Processed && r.entry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.toJSON().amount).toBe("100.00");
    expect(refund.referenceTransactionId).toBe(bet.id);
  });

  it.each([K.Win, K.Loss, K.Refund, K.Rollback])("of a %s is REFERENCE_KIND_NOT_ALLOWED", (kind) => {
    const w = openWallet("75.00");
    const ref = storedTx(w, {
      kind,
      amount: "25.00",
      externalTransactionId: "ref-1",
      referenceExternalTransactionId: kind === K.Refund || kind === K.Rollback ? "x" : undefined,
    });
    const refund = pendingTx(w, { kind: K.Refund, amount: "25.00", referenceExternalTransactionId: "ref-1" });
    expect(decide(w, refund, ref)).toEqual({ status: S.Rejected, failureCode: "REFERENCE_KIND_NOT_ALLOWED" });
    expect(w.version).toBe(1);
  });

  it("with a different amount is AMOUNT_MISMATCH", () => {
    const w = openWallet("75.00");
    const bet = storedTx(w, { kind: K.Bet, amount: "25.00", externalTransactionId: "bet-1" });
    const refund = pendingTx(w, { kind: K.Refund, amount: "24.99", referenceExternalTransactionId: "bet-1" });
    expect(decide(w, refund, bet)).toEqual({ status: S.Rejected, failureCode: "AMOUNT_MISMATCH" });
  });

  it("of an already reversed BET is ALREADY_REVERSED", () => {
    const w = openWallet("75.00");
    const bet = storedTx(w, { kind: K.Bet, amount: "25.00", externalTransactionId: "bet-1" });
    const refund = pendingTx(w, { kind: K.Refund, amount: "25.00", referenceExternalTransactionId: "bet-1" });
    expect(decide(w, refund, bet, { alreadyReversed: true })).toEqual({
      status: S.Rejected,
      failureCode: "ALREADY_REVERSED",
    });
    expect(w.balance.toJSON().amount).toBe("75.00");
  });
});

describe("ROLLBACK", () => {
  it("of a BET credits", () => {
    const w = openWallet("75.00");
    const bet = storedTx(w, { kind: K.Bet, amount: "25.00", externalTransactionId: "bet-1" });
    const rb = pendingTx(w, { kind: K.Rollback, amount: "25.00", referenceExternalTransactionId: "bet-1" });
    const r = decide(w, rb, bet);
    expect(r.status === S.Processed && r.entry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.toJSON().amount).toBe("100.00");
  });

  it("of a WIN debits", () => {
    const w = openWallet("130.00");
    const win = storedTx(w, { kind: K.Win, amount: "30.00", externalTransactionId: "win-1" });
    const rb = pendingTx(w, { kind: K.Rollback, amount: "30.00", referenceExternalTransactionId: "win-1" });
    const r = decide(w, rb, win);
    expect(r.status === S.Processed && r.entry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.toJSON().amount).toBe("100.00");
  });

  it("of a REFUND debits", () => {
    const w = openWallet("100.00");
    const refund = storedTx(w, {
      kind: K.Refund,
      amount: "25.00",
      externalTransactionId: "refund-1",
      referenceExternalTransactionId: "bet-1",
    });
    const rb = pendingTx(w, { kind: K.Rollback, amount: "25.00", referenceExternalTransactionId: "refund-1" });
    expect(decide(w, rb, refund).status).toBe(S.Processed);
    expect(w.balance.toJSON().amount).toBe("75.00");
  });

  it("that would make the balance negative is REVERSAL_INSUFFICIENT_FUNDS (distinct from a bet without funds)", () => {
    const w = openWallet("10.00");
    const win = storedTx(w, { kind: K.Win, amount: "30.00", externalTransactionId: "win-1" });
    const rb = pendingTx(w, { kind: K.Rollback, amount: "30.00", referenceExternalTransactionId: "win-1" });
    const r = decide(w, rb, win);
    expect(r).toEqual({ status: S.Rejected, failureCode: "REVERSAL_INSUFFICIENT_FUNDS" });
    expect(w.balance.toJSON().amount).toBe("10.00");
    expect(rb.status).toBe(S.Rejected);
  });

  it.each([K.Loss, K.Rollback])("of a %s is REFERENCE_KIND_NOT_ALLOWED", (kind) => {
    const w = openWallet("100.00");
    const ref = storedTx(w, {
      kind,
      amount: "5.00",
      externalTransactionId: "ref-1",
      referenceExternalTransactionId: kind === K.Rollback ? "x" : undefined,
    });
    const rb = pendingTx(w, { kind: K.Rollback, amount: "5.00", referenceExternalTransactionId: "ref-1" });
    expect(decide(w, rb, ref)).toEqual({ status: S.Rejected, failureCode: "REFERENCE_KIND_NOT_ALLOWED" });
  });

  it("of an already reversed transaction is ALREADY_REVERSED (at most one reversal of any kind)", () => {
    const w = openWallet("100.00");
    const bet = storedTx(w, { kind: K.Bet, amount: "5.00", externalTransactionId: "bet-1" });
    const rb = pendingTx(w, { kind: K.Rollback, amount: "5.00", referenceExternalTransactionId: "bet-1" });
    expect(decide(w, rb, bet, { alreadyReversed: true })).toEqual({
      status: S.Rejected,
      failureCode: "ALREADY_REVERSED",
    });
  });
});

describe("reference validation", () => {
  it.each([
    ["another wallet", { walletId: randomUUID() }],
    ["another player", { playerId: "someone-else" }],
    ["another round", { roundId: "round-2" }],
  ])("reference from %s is REFERENCE_MISMATCH", (_label, o) => {
    const w = openWallet("100.00");
    const bet = storedTx(w, { kind: K.Bet, amount: "5.00", externalTransactionId: "bet-1", ...o });
    const refund = pendingTx(w, { kind: K.Refund, amount: "5.00", referenceExternalTransactionId: "bet-1" });
    expect(decide(w, refund, bet)).toEqual({ status: S.Rejected, failureCode: "REFERENCE_MISMATCH" });
  });

  it("reference in another currency is REFERENCE_MISMATCH", () => {
    const w = openWallet("100.00");
    const bet = storedTx(w, { kind: K.Bet, money: usd("5.00"), externalTransactionId: "bet-1" });
    const refund = pendingTx(w, { kind: K.Refund, amount: "5.00", referenceExternalTransactionId: "bet-1" });
    expect(decide(w, refund, bet)).toEqual({ status: S.Rejected, failureCode: "REFERENCE_MISMATCH" });
  });

  it.each([S.Rejected, S.Failed])("reference %s is REFERENCE_NOT_PROCESSED", (status) => {
    const w = openWallet("100.00");
    const bet = storedTx(w, { kind: K.Bet, amount: "5.00", externalTransactionId: "bet-1", status });
    const refund = pendingTx(w, { kind: K.Refund, amount: "5.00", referenceExternalTransactionId: "bet-1" });
    expect(decide(w, refund, bet)).toEqual({ status: S.Rejected, failureCode: "REFERENCE_NOT_PROCESSED" });
  });
});

describe("rule order is fixed (same request, same code)", () => {
  it("currency mismatch wins over player mismatch and missing funds", () => {
    const w = openWallet("1.00");
    const tx = pendingTx(w, { kind: K.Bet, money: usd("500.00"), playerId: "intruder" });
    expect(decide(w, tx)).toEqual({ status: S.Rejected, failureCode: "CURRENCY_MISMATCH" });
  });

  it("player mismatch wins over missing funds", () => {
    const w = openWallet("1.00");
    const tx = pendingTx(w, { kind: K.Bet, amount: "500.00", playerId: "intruder" });
    expect(decide(w, tx)).toEqual({ status: S.Rejected, failureCode: "PLAYER_WALLET_MISMATCH" });
  });

  it("a transaction aimed at another wallet is a programming error", () => {
    const w = openWallet("1.00");
    const other = openWallet("1.00");
    expect(() => decide(w, pendingTx(other))).toThrow(InvariantViolationError);
  });
});

describe("references out of order (PENDING_REFERENCE)", () => {
  it("missing reference → PENDING_REFERENCE with schedule and TTL, nothing moves", () => {
    const w = openWallet("100.00");
    const refund = pendingTx(w, { kind: K.Refund, amount: "5.00", referenceExternalTransactionId: "bet-late" });
    expect(decide(w, refund)).toEqual({ status: S.PendingReference, rescheduled: false });
    expect(refund.status).toBe(S.PendingReference);
    expect(refund.pendingDeadlineAt).toEqual(new Date(NOW.getTime() + 600_000));
    expect(refund.nextAttemptAt!.getTime()).toBe(NOW.getTime() + 1_000);
    expect(refund.resultBalance!.toJSON().amount).toBe("100.00");
    expect(w.version).toBe(1);
  });

  it("reference still pending → PENDING_REFERENCE as well", () => {
    const w = openWallet("100.00");
    const ref = storedTx(w, {
      kind: K.Refund,
      amount: "5.00",
      externalTransactionId: "refund-1",
      referenceExternalTransactionId: "bet-x",
      status: S.PendingReference,
    });
    const rb = pendingTx(w, { kind: K.Rollback, amount: "5.00", referenceExternalTransactionId: "refund-1" });
    expect(decide(w, rb, ref).status).toBe(S.PendingReference);
  });

  it("worker run before the deadline with the reference still missing → retry with backoff", () => {
    const w = openWallet("100.00");
    const refund = pendingTx(w, { kind: K.Refund, amount: "5.00", referenceExternalTransactionId: "bet-late" });
    decide(w, refund);
    const later = new Date(NOW.getTime() + 5_000);
    expect(decide(w, refund, undefined, { now: later })).toEqual({ status: S.PendingReference, rescheduled: true });
    expect(refund.attempts).toBe(1);
    expect(refund.nextAttemptAt!.getTime()).toBe(later.getTime() + 2_000);
  });

  it("worker run when the reference arrived → PROCESSED", () => {
    const w = openWallet("95.00");
    const refund = pendingTx(w, { kind: K.Refund, amount: "5.00", referenceExternalTransactionId: "bet-late" });
    decide(w, refund);
    const bet = storedTx(w, { kind: K.Bet, amount: "5.00", externalTransactionId: "bet-late" });
    const r = decide(w, refund, bet, { now: new Date(NOW.getTime() + 3_000) });
    expect(r.status).toBe(S.Processed);
    expect(w.balance.toJSON().amount).toBe("100.00");
    expect(refund.referenceTransactionId).toBe(bet.id);
  });

  it("deadline reached with the reference missing → REJECTED REFERENCE_NOT_FOUND", () => {
    const w = openWallet("100.00");
    const refund = pendingTx(w, { kind: K.Refund, amount: "5.00", referenceExternalTransactionId: "never" });
    decide(w, refund);
    const r = decide(w, refund, undefined, { now: new Date(NOW.getTime() + 600_000) });
    expect(r).toEqual({ status: S.Rejected, failureCode: "REFERENCE_NOT_FOUND" });
    expect(refund.status).toBe(S.Rejected);
  });

  it("deadline reached with the reference still pending → REJECTED REFERENCE_NOT_PROCESSED", () => {
    const w = openWallet("100.00");
    const ref = storedTx(w, {
      kind: K.Refund,
      amount: "5.00",
      externalTransactionId: "refund-1",
      referenceExternalTransactionId: "bet-x",
      status: S.PendingReference,
    });
    const rb = pendingTx(w, { kind: K.Rollback, amount: "5.00", referenceExternalTransactionId: "refund-1" });
    decide(w, rb, ref);
    expect(decide(w, rb, ref, { now: new Date(NOW.getTime() + 600_001) })).toEqual({
      status: S.Rejected,
      failureCode: "REFERENCE_NOT_PROCESSED",
    });
  });

  it("refuses to decide a terminal transaction", () => {
    const w = openWallet("100.00");
    const done = storedTx(w, { kind: K.Bet, status: S.Processed });
    expect(() => decide(w, done)).toThrow();
  });
});

describe("PendingReferencePolicy backoff", () => {
  it("doubles up to the cap, scaled by jitter in [0.5, 1]", () => {
    const p = PendingReferencePolicy.create({ ttlMs: 600_000, baseDelayMs: 1_000, maxDelayMs: 60_000 });
    expect(p.nextAttemptAt(T0, 1, () => 1).getTime() - T0.getTime()).toBe(2_000);
    expect(p.nextAttemptAt(T0, 3, () => 1).getTime() - T0.getTime()).toBe(8_000);
    expect(p.nextAttemptAt(T0, 10, () => 1).getTime() - T0.getTime()).toBe(60_000);
    expect(p.nextAttemptAt(T0, 3, () => 0).getTime() - T0.getTime()).toBe(4_000);
  });

  it("rejects nonsense configuration", () => {
    expect(() => PendingReferencePolicy.create({ ttlMs: 0, baseDelayMs: 1, maxDelayMs: 1 })).toThrow();
    expect(() => PendingReferencePolicy.create({ ttlMs: 10, baseDelayMs: 5, maxDelayMs: 1 })).toThrow();
  });
});
