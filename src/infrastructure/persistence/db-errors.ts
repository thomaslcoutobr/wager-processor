import {
  DatabaseInvariantError,
  RetryableConflictError,
  TransientError,
  UniqueViolationError,
} from "../../application/errors";

const SQLSTATE = /^[0-9A-Z]{5}$/;
const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH"]);
const NETWORK_MESSAGES = /timeout exceeded when trying to connect|Query read timeout|Connection terminated|connection is closed|Client has encountered a connection error/i;
const BUG_STATES = new Set(["23514", "23503", "23502", "22P02", "22003", "P0001"]);

interface DriverLike {
  code?: unknown;
  sqlState?: unknown;
  constraint?: unknown;
  message?: unknown;
  cause?: unknown;
}

function sqlstateOf(e: DriverLike): string | undefined {
  for (const v of [e.sqlState, e.code]) if (typeof v === "string" && SQLSTATE.test(v)) return v;
  return undefined;
}

/**
 * Translates a driver/ORM error into the application's error classes (ARCHITECTURE §11).
 * Errors that are not database errors (domain errors, failpoints, control flow) pass through untouched.
 */
export function translateDbError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  if (
    err instanceof TransientError ||
    err instanceof RetryableConflictError ||
    err instanceof UniqueViolationError ||
    err instanceof DatabaseInvariantError
  ) {
    return err;
  }
  const e = err as DriverLike & Error;
  const state = sqlstateOf(e);
  if (state) {
    if (state === "23505") return new UniqueViolationError(typeof e.constraint === "string" ? e.constraint : undefined, { cause: err });
    if (state === "55P03") return new TransientError("LOCK_TIMEOUT", "wallet is busy (lock_timeout)", state, { cause: err });
    if (state === "40P01" || state === "40001") return new RetryableConflictError(state, { cause: err });
    // 25006: the database only reads (failover window); like being down, it passes by itself
    if (state.startsWith("08") || state.startsWith("53") || state.startsWith("57") || state === "25006") {
      return new TransientError("DATABASE_UNAVAILABLE", `database unavailable (${state})`, state, { cause: err });
    }
    if (BUG_STATES.has(state)) return new DatabaseInvariantError(state, err.message, { cause: err });
    return err;
  }
  if ((typeof e.code === "string" && NETWORK_CODES.has(e.code)) || NETWORK_MESSAGES.test(err.message) || err.name === "ConnectionException") {
    return new TransientError("DATABASE_UNAVAILABLE", "database unreachable", undefined, { cause: err });
  }
  return err;
}
