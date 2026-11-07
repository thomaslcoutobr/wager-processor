import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  INTERNAL_PROVIDER_ID,
  WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from "../../src/domain/wager-transaction";
import { LedgerDirection } from "../../src/domain/ledger-entry";
import { DomainValidationError, InvalidTransactionStateError, InvariantViolationError } from "../../src/domain/errors";
import { brl, openWallet, pendingTx, storedTx, T0 } from "../helpers/domain-builders";

const T1 = new Date("2026-11-07T12:00:05.000Z");
const wallet = openWallet("100.00");

describe("WagerTransaction.create", () => {
  it("is born PENDING with zero attempts", () => {
    const tx = pendingTx(wallet);
    expect(tx.status).toBe(S.Pending);
    expect(tx.attempts).toBe(0);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.processedAt).toBeUndefined();
  });

  it.each([K.Refund, K.Rollback])("%s without referenceExternalTransactionId fails with MISSING_REFERENCE", (kind) => {
    try {
      pendingTx(wallet, { kind });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DomainValidationError);
      expect((e as DomainValidationError).code).toBe("MISSING_REFERENCE");
    }
  });

  it("OPENING cannot be created through the public factory (FORBIDDEN_KIND)", () => {
    try {
      pendingTx(wallet, { kind: K.Opening });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as DomainValidationError).code).toBe("FORBIDDEN_KIND");
    }
  });

  it("the internal provider id is reserved", () => {
    expect(() => pendingTx(wallet, { providerId: INTERNAL_PROVIDER_ID })).toThrow(DomainValidationError);
  });

  it("BET cannot carry a reference", () => {
    expect(() => pendingTx(wallet, { kind: K.Bet, referenceExternalTransactionId: "x" })).toThrow(DomainValidationError);
  });

  it("a transaction cannot reference itself", () => {
    expect(() =>
      pendingTx(wallet, { kind: K.Refund, externalTransactionId: "same", referenceExternalTransactionId: "same" }),
    ).toThrow(DomainValidationError);
  });

  it("WIN and LOSS may carry an optional reference", () => {
    expect(pendingTx(wallet, { kind: K.Win, referenceExternalTransactionId: "bet-1" }).referenceExternalTransactionId).toBe(
      "bet-1",
    );
    expect(pendingTx(wallet, { kind: K.Loss }).referenceExternalTransactionId).toBeUndefined();
  });

  it("WagerTransaction.opening builds the internal OPENING credit", () => {
    const tx = WagerTransaction.opening({
      id: randomUUID(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: brl("100.00"),
      at: T0,
    });
    expect(tx.kind).toBe(K.Opening);
    expect(tx.providerId).toBe(INTERNAL_PROVIDER_ID);
    expect(tx.externalTransactionId).toBe(`opening:${wallet.id}`);
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});

describe("WagerTransaction transitions", () => {
  it("PENDING → PROCESSED records the result balance and time", () => {
    const tx = pendingTx(wallet);
    tx.markProcessed({ resultBalance: brl("90.00"), at: T1 });
    expect(tx.status).toBe(S.Processed);
    expect(tx.processedAt).toEqual(T1);
    expect(tx.resultBalance!.toJSON().amount).toBe("90.00");
    expect(tx.isTerminal()).toBe(true);
  });

  it("PENDING → REJECTED requires a business failure code", () => {
    const tx = pendingTx(wallet);
    tx.reject({ code: "INSUFFICIENT_FUNDS", resultBalance: brl("5.00"), at: T1 });
    expect(tx.status).toBe(S.Rejected);
    expect(tx.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(() => pendingTx(wallet).reject({ code: "PROCESSING_FAILED", resultBalance: brl("1.00"), at: T1 })).toThrow(
      InvariantViolationError,
    );
  });

  it("PENDING → FAILED requires a permanent failure code", () => {
    const tx = pendingTx(wallet);
    tx.fail({ code: "PROCESSING_FAILED", at: T1 });
    expect(tx.status).toBe(S.Failed);
    expect(() => pendingTx(wallet).fail({ code: "INSUFFICIENT_FUNDS", at: T1 })).toThrow(InvariantViolationError);
  });

  it("PENDING → PENDING_REFERENCE → retry → PROCESSED", () => {
    const tx = pendingTx(wallet, { kind: K.Refund, referenceExternalTransactionId: "bet-1" });
    const deadline = new Date(T0.getTime() + 600_000);
    tx.markPendingReference({ resultBalance: brl("100.00"), nextAttemptAt: T1, deadlineAt: deadline });
    expect(tx.status).toBe(S.PendingReference);
    expect(tx.pendingDeadlineAt).toEqual(deadline);
    tx.scheduleRetry({ nextAttemptAt: new Date(T1.getTime() + 2000) });
    expect(tx.attempts).toBe(1);
    expect(tx.status).toBe(S.PendingReference);
    const refId = randomUUID();
    tx.markProcessed({ referenceTransactionId: refId, resultBalance: brl("110.00"), at: T1 });
    expect(tx.status).toBe(S.Processed);
    expect(tx.referenceTransactionId).toBe(refId);
    expect(tx.nextAttemptAt).toBeUndefined();
  });

  it("only transactions with a reference can wait for one", () => {
    expect(() =>
      pendingTx(wallet).markPendingReference({ resultBalance: brl("1.00"), nextAttemptAt: T1, deadlineAt: T1 }),
    ).toThrow(InvariantViolationError);
  });

  it("scheduleRetry only from PENDING_REFERENCE", () => {
    expect(() => pendingTx(wallet).scheduleRetry({ nextAttemptAt: T1 })).toThrow(InvalidTransactionStateError);
  });

  it("a processed REFUND/ROLLBACK must know its reference id", () => {
    const tx = pendingTx(wallet, { kind: K.Rollback, referenceExternalTransactionId: "bet-1" });
    expect(() => tx.markProcessed({ resultBalance: brl("1.00"), at: T1 })).toThrow(InvariantViolationError);
  });

  describe.each([S.Processed, S.Rejected, S.Failed])("terminal %s", (status) => {
    const make = () => storedTx(wallet, { kind: K.Win, referenceExternalTransactionId: "bet-1", status });
    it.each([
      ["markProcessed", (tx: WagerTransaction) => tx.markProcessed({ resultBalance: brl("1.00"), at: T1 })],
      ["reject", (tx: WagerTransaction) => tx.reject({ code: "INSUFFICIENT_FUNDS", resultBalance: brl("1.00"), at: T1 })],
      ["fail", (tx: WagerTransaction) => tx.fail({ code: "PROCESSING_FAILED", at: T1 })],
      [
        "markPendingReference",
        (tx: WagerTransaction) => tx.markPendingReference({ resultBalance: brl("1.00"), nextAttemptAt: T1, deadlineAt: T1 }),
      ],
      ["scheduleRetry", (tx: WagerTransaction) => tx.scheduleRetry({ nextAttemptAt: T1 })],
    ])("%s throws InvalidTransactionStateError", (_name, fn) => {
      const tx = make();
      expect(() => fn(tx)).toThrow(InvalidTransactionStateError);
      expect(tx.status).toBe(status);
    });
  });

  it("PENDING_REFERENCE cannot re-enter PENDING_REFERENCE (scheduleRetry is the only loop)", () => {
    const tx = storedTx(wallet, { kind: K.Refund, referenceExternalTransactionId: "b", status: S.PendingReference });
    expect(() => tx.markPendingReference({ resultBalance: brl("1.00"), nextAttemptAt: T1, deadlineAt: T1 })).toThrow(
      InvalidTransactionStateError,
    );
  });
});

describe("WagerTransaction queries", () => {
  it("affectsBalance is false only for LOSS; requiresReference only for REFUND and ROLLBACK", () => {
    expect(pendingTx(wallet, { kind: K.Loss }).affectsBalance()).toBe(false);
    expect(pendingTx(wallet, { kind: K.Bet }).affectsBalance()).toBe(true);
    expect(pendingTx(wallet, { kind: K.Win }).requiresReference()).toBe(false);
    expect(pendingTx(wallet, { kind: K.Refund, referenceExternalTransactionId: "b" }).requiresReference()).toBe(true);
    expect(pendingTx(wallet, { kind: K.Rollback, referenceExternalTransactionId: "b" }).requiresReference()).toBe(true);
  });

  it("matchesPayload compares the stored hash", () => {
    const tx = pendingTx(wallet);
    expect(tx.matchesPayload("v1:sha256:test")).toBe(true);
    expect(tx.matchesPayload("v1:sha256:other")).toBe(false);
  });

  it("ledgerDirectionFor follows the rules table", () => {
    const bet = storedTx(wallet, { kind: K.Bet });
    const win = storedTx(wallet, { kind: K.Win });
    const refund = storedTx(wallet, { kind: K.Refund, referenceExternalTransactionId: "b" });
    expect(pendingTx(wallet, { kind: K.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(pendingTx(wallet, { kind: K.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(pendingTx(wallet, { kind: K.Loss }).ledgerDirectionFor()).toBeUndefined();
    expect(pendingTx(wallet, { kind: K.Refund, referenceExternalTransactionId: "b" }).ledgerDirectionFor(bet)).toBe(
      LedgerDirection.Credit,
    );
    const rollback = pendingTx(wallet, { kind: K.Rollback, referenceExternalTransactionId: "b" });
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvariantViolationError);
  });

  it("rehydrate restores any persisted status without validating transitions", () => {
    const tx = storedTx(wallet, { status: S.Rejected });
    expect(tx.status).toBe(S.Rejected);
    expect(tx.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(WagerTransaction.rehydrate(tx.toState()).toState()).toEqual(tx.toState());
  });
});
