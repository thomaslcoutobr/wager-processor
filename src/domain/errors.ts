import type { ValidationCode } from "./failure-code";

/** Base for every error raised by the domain. `code` is stable and machine-readable. */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Input that a contract must refuse (maps to HTTP 400). */
export class DomainValidationError extends DomainError {
  constructor(
    readonly code: ValidationCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

export class InvalidMoneyError extends DomainValidationError {
  constructor(message: string, field = "money.amount") {
    super("INVALID_AMOUNT", message, field);
  }
}

export class InvalidCurrencyError extends DomainValidationError {
  constructor(message: string, field = "money.currency") {
    super("INVALID_CURRENCY", message, field);
  }
}

/** Arithmetic or comparison between different currencies. */
export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";

  constructor(expected: string, actual: string) {
    super(`currency mismatch: expected ${expected}, got ${actual}`);
  }
}

/** A transition was attempted from a state that does not allow it (programming error). */
export class InvalidTransactionStateError extends DomainError {
  readonly code = "INVALID_TRANSACTION_STATE";

  constructor(message: string) {
    super(message);
  }
}

/** Same as above, for aggregates other than WagerTransaction (outbox, inbox). */
export class InvalidStateError extends DomainError {
  readonly code = "INVALID_STATE";

  constructor(message: string) {
    super(message);
  }
}

/** balanceBefore ± amount !== balanceAfter. */
export class LedgerEntryImbalanceError extends DomainError {
  readonly code = "LEDGER_ENTRY_IMBALANCE";

  constructor(message: string) {
    super(message);
  }
}

/** A domain invariant would be broken by the caller (programming error, never a business outcome). */
export class InvariantViolationError extends DomainError {
  readonly code = "INVARIANT_VIOLATION";

  constructor(message: string) {
    super(message);
  }
}
