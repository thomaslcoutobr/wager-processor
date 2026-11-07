import type { TransientCode } from "../domain/failure-code";

/**
 * Infrastructure failures, translated from driver errors so the application never inspects
 * SQLSTATEs itself. Classification (ARCHITECTURE §11):
 *   08xxx, 53xxx, 57xxx, 55P03, network errors → TransientError
 *   40P01, 40001                               → RetryableConflictError (retried internally, then transient)
 *   23505                                      → UniqueViolationError (use case re-runs once)
 *   23514, 23503, 22P02, P0001                 → DatabaseInvariantError (a bug: validation/domain should have stopped it)
 */
export class TransientError extends Error {
  constructor(
    readonly code: TransientCode,
    message: string,
    readonly sqlstate?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "TransientError";
  }
}

export class RetryableConflictError extends Error {
  constructor(
    readonly sqlstate: string,
    options?: { cause?: unknown },
  ) {
    super(`database conflict ${sqlstate}`, options);
    this.name = "RetryableConflictError";
  }
}

export class UniqueViolationError extends Error {
  constructor(
    readonly constraint: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(`unique violation${constraint ? ` on ${constraint}` : ""}`, options);
    this.name = "UniqueViolationError";
  }
}

export class DatabaseInvariantError extends Error {
  constructor(
    readonly sqlstate: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DatabaseInvariantError";
  }
}
