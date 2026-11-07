import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { Wallet } from "../../src/domain/wallet";
import { LedgerDirection, type WalletLedgerEntry } from "../../src/domain/ledger-entry";
import { Money } from "../../src/domain/money";
import { CurrencyMismatchError, DomainValidationError, InvariantViolationError } from "../../src/domain/errors";
import { brl, openWallet, T0, usd } from "../helpers/domain-builders";

const T1 = new Date("2026-11-07T12:01:00.000Z");
const move = (money: Money) => ({ money, transactionId: randomUUID(), entryId: randomUUID(), at: T1 });

describe("Wallet.open", () => {
  it("starts at version 1 with an OPENING credit entry when the initial balance is positive", () => {
    const openingTransactionId = randomUUID();
    const { wallet, openingEntry } = Wallet.open({
      id: randomUUID(),
      playerId: "p-1",
      initialBalance: brl("100.00"),
      at: T0,
      openingTransactionId,
      openingEntryId: randomUUID(),
    });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON()).toEqual({ amount: "100.00", currency: "BRL" });
    expect(wallet.currency).toBe("BRL");
    expect(openingEntry).toBeDefined();
    expect(openingEntry!.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry!.balanceBefore.toJSON().amount).toBe("0.00");
    expect(openingEntry!.balanceAfter.toJSON().amount).toBe("100.00");
    expect(openingEntry!.walletVersion).toBe(1);
    expect(openingEntry!.transactionId).toBe(openingTransactionId);
  });

  it("starts at version 1 without any entry when the initial balance is zero", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: randomUUID(),
      playerId: "p-1",
      initialBalance: Money.zero("BRL"),
      at: T0,
      openingTransactionId: randomUUID(),
      openingEntryId: randomUUID(),
    });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.isZero()).toBe(true);
    expect(openingEntry).toBeUndefined();
  });

  it.each(["", "x".repeat(65)])("rejects an invalid playerId %p", (playerId) => {
    expect(() =>
      Wallet.open({
        id: randomUUID(),
        playerId,
        initialBalance: brl("1.00"),
        at: T0,
        openingTransactionId: randomUUID(),
        openingEntryId: randomUUID(),
      }),
    ).toThrow(DomainValidationError);
  });
});

describe("Wallet.debit / credit", () => {
  it("debit moves the balance, bumps version once and returns exactly one entry", () => {
    const w = openWallet("100.00");
    const r = w.debit(move(brl("30.00")));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(w.balance.toJSON().amount).toBe("70.00");
    expect(w.version).toBe(2);
    expect(w.updatedAt).toEqual(T1);
    expect(r.entry.direction).toBe(LedgerDirection.Debit);
    expect(r.entry.balanceBefore.toJSON().amount).toBe("100.00");
    expect(r.entry.balanceAfter.toJSON().amount).toBe("70.00");
    expect(r.entry.walletVersion).toBe(2);
  });

  it("debit of the whole balance leaves exactly 0.00", () => {
    const w = openWallet("80.00");
    expect(w.debit(move(brl("80.00"))).ok).toBe(true);
    expect(w.balance.toJSON().amount).toBe("0.00");
  });

  it("insufficient funds is a result, not an exception, and changes nothing", () => {
    const w = openWallet("100.00");
    const r = w.debit(move(brl("100.01")));
    expect(r).toEqual({ ok: false, reason: "INSUFFICIENT_FUNDS" });
    expect(w.balance.toJSON().amount).toBe("100.00");
    expect(w.version).toBe(1);
  });

  it("credit moves the balance and bumps version", () => {
    const w = openWallet("1.00");
    const r = w.credit(move(brl("2.50")));
    expect(r.ok).toBe(true);
    expect(w.balance.toJSON().amount).toBe("3.50");
    expect(w.version).toBe(2);
  });

  it("operation currency must equal wallet currency", () => {
    const w = openWallet("100.00");
    expect(() => w.debit(move(usd("1.00")))).toThrow(CurrencyMismatchError);
    expect(() => w.credit(move(usd("1.00")))).toThrow(CurrencyMismatchError);
    expect(w.version).toBe(1);
  });

  it("refuses zero or negative movements (they never produce entries)", () => {
    const w = openWallet("100.00");
    expect(() => w.debit(move(Money.zero("BRL")))).toThrow(InvariantViolationError);
    expect(() => w.credit(move(brl("1.00").negate()))).toThrow(InvariantViolationError);
  });

  it("balance always equals the sum of its entries, and versions are contiguous", () => {
    const { wallet: w, openingEntry } = Wallet.open({
      id: randomUUID(),
      playerId: "p-1",
      initialBalance: brl("50.00"),
      at: T0,
      openingTransactionId: randomUUID(),
      openingEntryId: randomUUID(),
    });
    const entries: WalletLedgerEntry[] = [openingEntry!];
    const ops: Array<["debit" | "credit", string]> = [
      ["debit", "20.00"],
      ["credit", "5.55"],
      ["debit", "100.00"], // rejected
      ["debit", "35.55"],
      ["credit", "0.01"],
    ];
    for (const [op, amount] of ops) {
      const r = w[op](move(brl(amount)));
      if (r.ok) entries.push(r.entry);
    }
    const sum = entries.reduce((acc, e) => acc.add(e.signedAmount()), Money.zero("BRL"));
    expect(sum.equals(w.balance)).toBe(true);
    expect(w.balance.toJSON().amount).toBe("0.01");
    expect(entries.map((e) => e.walletVersion)).toEqual([1, 2, 3, 4, 5]);
    expect(w.version).toBe(5);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]!.balanceBefore.equals(entries[i - 1]!.balanceAfter)).toBe(true);
    }
  });
});

describe("Wallet.rehydrate", () => {
  it("rebuilds persisted state without re-running any rule", () => {
    const w = Wallet.rehydrate({
      id: randomUUID(),
      playerId: "p-9",
      currency: "BRL",
      balance: brl("12.34"),
      version: 7,
      createdAt: T0,
      updatedAt: T1,
    });
    expect(w.version).toBe(7);
    expect(w.balance.toJSON().amount).toBe("12.34");
    expect(w.toState().updatedAt).toEqual(T1);
  });
});
