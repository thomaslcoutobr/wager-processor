import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { LedgerDirection, WalletLedgerEntry } from "../../src/domain/ledger-entry";
import { InvariantViolationError, LedgerEntryImbalanceError } from "../../src/domain/errors";
import { brl, T0, usd } from "../helpers/domain-builders";

function props(direction: LedgerDirection, amount: string, before: string, after: string) {
  return {
    id: randomUUID(),
    walletId: randomUUID(),
    transactionId: randomUUID(),
    direction,
    money: brl(amount),
    balanceBefore: brl(before),
    balanceAfter: brl(after),
    walletVersion: 2,
    createdAt: T0,
  };
}

describe("WalletLedgerEntry.create", () => {
  it("accepts a balanced debit and a balanced credit", () => {
    expect(WalletLedgerEntry.create(props(LedgerDirection.Debit, "30.00", "100.00", "70.00")).isBalanced()).toBe(true);
    expect(WalletLedgerEntry.create(props(LedgerDirection.Credit, "30.00", "70.00", "100.00")).isBalanced()).toBe(true);
  });

  it("refuses arithmetic that does not close", () => {
    expect(() => WalletLedgerEntry.create(props(LedgerDirection.Debit, "30.00", "100.00", "71.00"))).toThrow(
      LedgerEntryImbalanceError,
    );
    expect(() => WalletLedgerEntry.create(props(LedgerDirection.Credit, "30.00", "100.00", "70.00"))).toThrow(
      LedgerEntryImbalanceError,
    );
  });

  it("refuses zero amount (operations without balance effect have no entry)", () => {
    expect(() => WalletLedgerEntry.create(props(LedgerDirection.Credit, "0.00", "1.00", "1.00"))).toThrow(
      InvariantViolationError,
    );
  });

  it("refuses an entry that would leave a negative balance", () => {
    const p = { ...props(LedgerDirection.Debit, "30.00", "10.00", "10.00"), balanceAfter: brl("10.00").subtract(brl("30.00")) };
    expect(() => WalletLedgerEntry.create(p)).toThrow(InvariantViolationError);
  });

  it("refuses mixed currencies", () => {
    const p = { ...props(LedgerDirection.Credit, "1.00", "1.00", "2.00"), money: usd("1.00") };
    expect(() => WalletLedgerEntry.create(p)).toThrow();
  });

  it("refuses wallet version below 1", () => {
    expect(() =>
      WalletLedgerEntry.create({ ...props(LedgerDirection.Credit, "1.00", "0.00", "1.00"), walletVersion: 0 }),
    ).toThrow(InvariantViolationError);
  });

  it("is structurally immutable (frozen, no transition methods)", () => {
    const entry = WalletLedgerEntry.create(props(LedgerDirection.Credit, "1.00", "0.00", "1.00"));
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { money: unknown }).money = brl("999.00");
    }).toThrow(TypeError);
  });

  it("rehydrate rebuilds a persisted entry", () => {
    const p = props(LedgerDirection.Debit, "5.00", "10.00", "5.00");
    const entry = WalletLedgerEntry.rehydrate(p);
    expect(entry.balanceAfter.toJSON().amount).toBe("5.00");
    expect(entry.signedAmount().toJSON().amount).toBe("-5.00");
  });
});
