import { describe, expect, it } from "bun:test";
import { Money } from "../../src/domain/money";
import { CurrencyMismatchError, InvalidCurrencyError, InvalidMoneyError } from "../../src/domain/errors";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money.from: accepted input", () => {
  it.each(["0.00", "0.01", "25.00", "1000.50", "999999999999999999.99"])("accepts %s", (amount) => {
    expect(brl(amount).toJSON()).toEqual({ amount, currency: "BRL" });
  });

  it("accepts any ISO-4217 currency known to the runtime", () => {
    expect(Money.from({ amount: "1.00", currency: "USD" }).currency).toBe("USD");
  });
});

describe("Money.from: rejected input (never rounded, never coerced)", () => {
  it.each([
    ["empty string", ""],
    ["no decimals", "25"],
    ["one decimal", "25.5"],
    ["three decimals (would be silent rounding)", "25.005"],
    ["negative", "-1.00"],
    ["explicit plus sign", "+1.00"],
    ["scientific notation", "1e3"],
    ["scientific with decimals", "1.00e2"],
    ["hexadecimal", "0x10"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["leading zero", "01.00"],
    ["comma separator", "1,00"],
    ["surrounding whitespace", " 1.00"],
    ["19 integer digits (column is numeric(20,2))", "1000000000000000000.00"],
  ])("rejects %s", (_label, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  it.each([
    ["a JS number", 25],
    ["null", null],
    ["undefined", undefined],
    ["an object", { value: "1.00" }],
  ])("rejects amount given as %s", (_label, amount) => {
    expect(() => Money.from({ amount: amount as unknown as string, currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  it.each(["brl", "BR", "BRLL", "ZZZ", "", "R$"])("rejects currency %p", (currency) => {
    expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidCurrencyError);
  });

  it("carries a machine-readable code", () => {
    try {
      brl("1e3");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as InvalidMoneyError).code).toBe("INVALID_AMOUNT");
    }
  });
});

describe("Money arithmetic is exact (no binary floating point)", () => {
  it("0.10 + 0.20 = 0.30 exactly", () => {
    expect(brl("0.10").add(brl("0.20")).toJSON().amount).toBe("0.30");
  });

  it("adding one cent a thousand times gives 10.00", () => {
    let total = Money.zero("BRL");
    for (let i = 0; i < 1000; i++) total = total.add(brl("0.01"));
    expect(total.toJSON().amount).toBe("10.00");
  });

  it("keeps all digits at the column limit (no silent rounding of large values)", () => {
    const max = brl("999999999999999999.99");
    expect(max.add(max).toJSON().amount).toBe("1999999999999999999.98");
    expect(max.subtract(brl("0.01")).toJSON().amount).toBe("999999999999999999.98");
  });

  it("subtract can go negative internally; negate flips the sign", () => {
    const r = brl("10.00").subtract(brl("10.01"));
    expect(r.isNegative()).toBe(true);
    expect(r.toJSON().amount).toBe("-0.01");
    expect(r.negate().toJSON().amount).toBe("0.01");
  });

  it("zero, positive and negative predicates", () => {
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(Money.zero("BRL").isPositive()).toBe(false);
    expect(Money.zero("BRL").isNegative()).toBe(false);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("0.01").negate().isNegative()).toBe(true);
  });

  it("comparison and equality", () => {
    expect(brl("79.99").isLessThan(brl("80.00"))).toBe(true);
    expect(brl("80.00").isLessThan(brl("80.00"))).toBe(false);
    expect(brl("80.00").equals(brl("80.00"))).toBe(true);
    expect(brl("80.00").equals(Money.from({ amount: "80.00", currency: "USD" }))).toBe(false);
  });

  it("is immutable: operations return new instances", () => {
    const a = brl("10.00");
    const b = a.add(brl("5.00"));
    expect(b).not.toBe(a);
    expect(a.toJSON().amount).toBe("10.00");
    expect(Object.isFrozen(a)).toBe(true);
  });

  it("serializes always with 2 decimals", () => {
    expect(Money.zero("BRL").toJSON()).toEqual({ amount: "0.00", currency: "BRL" });
    expect(brl("1.50").toString()).toBe("1.50 BRL");
    expect(JSON.stringify({ m: brl("7.00") })).toBe('{"m":{"amount":"7.00","currency":"BRL"}}');
  });
});

describe("Money currency conflicts", () => {
  const usd = Money.from({ amount: "1.00", currency: "USD" });
  it.each([
    ["add", () => brl("1.00").add(usd)],
    ["subtract", () => brl("1.00").subtract(usd)],
    ["isLessThan", () => brl("1.00").isLessThan(usd)],
  ])("%s across currencies throws CurrencyMismatchError", (_op, fn) => {
    expect(fn).toThrow(CurrencyMismatchError);
  });
});
