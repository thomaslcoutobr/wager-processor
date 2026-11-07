import Decimal from "decimal.js";
import { CurrencyMismatchError, InvalidCurrencyError, InvalidMoneyError } from "./errors";

/** Contract DTO: amount is always a decimal string with exactly 2 places. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

/**
 * Isolated Decimal constructor. The library default (20 significant digits) equals the column
 * width numeric(20,2) with no headroom; 40 digits means add/subtract never round silently.
 */
const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/**
 * Checked BEFORE building a Decimal, because decimal.js itself accepts NaN, Infinity, "1e3"
 * and "0x10". Up to 18 integer digits + 2 decimals fits numeric(20,2).
 */
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const KNOWN_CURRENCIES: ReadonlySet<string> = new Set(Intl.supportedValuesOf("currency"));

export const MONEY_SCALE = 2;

export class Money {
  private constructor(
    private readonly value: Decimal,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** The only way in from the outside: validated string, non-negative, 2 decimals. */
  static from(props: MoneyProps): Money {
    const amount: unknown = props?.amount;
    if (typeof amount !== "string" || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(`amount must be a decimal string with exactly ${MONEY_SCALE} places, e.g. "25.00"`);
    }
    return new Money(new Dec(amount), Money.validCurrency(props.currency));
  }

  static zero(currency: string): Money {
    return new Money(new Dec(0), Money.validCurrency(currency));
  }

  private static validCurrency(currency: unknown): string {
    if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency) || !KNOWN_CURRENCIES.has(currency)) {
      throw new InvalidCurrencyError("currency must be an ISO-4217 code, e.g. \"BRL\"");
    }
    return currency;
  }

  get amount(): string {
    return this.value.toFixed(MONEY_SCALE);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  /** Same currency and same amount. Different currency is simply "not equal". */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) throw new CurrencyMismatchError(this.currency, other.currency);
  }
}
