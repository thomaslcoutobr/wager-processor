import { DomainValidationError } from "../domain/errors";
import type { ValidationCode } from "../domain/failure-code";
import { Money } from "../domain/money";
import { WagerTransactionKind } from "../domain/wager-transaction";

export type ExternalWagerKind = Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;

/** A validated request to apply a wager transaction. Same shape from HTTP and from SQS. */
export interface SubmitWagerCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: ExternalWagerKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

export interface FieldError {
  field: string;
  code: ValidationCode;
  message: string;
}

export type ParseResult =
  | { ok: true; command: SubmitWagerCommand }
  | { ok: false; code: ValidationCode; errors: FieldError[] };

/** Same rules as the CHECK constraints, so the schema never answers with a generic error. */
export const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const IDEMPOTENCY_KEY_MAX = 255;
/** C0 controls and DEL: never part of an id, and Postgres refuses NUL in text (22021). */
export const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
export const EXTERNAL_ID_MAX = 128;
const PLAYER_ID_MAX = 64;

const EXTERNAL_KINDS: ReadonlySet<string> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validates an untrusted body (+ the idempotency key, which comes from the header on HTTP and
 * from `data.idempotencyKey` on SQS). Pure: no I/O. Reports every invalid field; the top-level
 * code is the field's code when there is only one, VALIDATION_ERROR otherwise.
 */
export function parseWagerCommand(body: unknown, idempotencyKey: unknown): ParseResult {
  const errors: FieldError[] = [];
  const fail = (field: string, code: ValidationCode, message: string) => errors.push({ field, code, message });

  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    fail("Idempotency-Key", "MISSING_IDEMPOTENCY_KEY", "Idempotency-Key is required");
  } else if (idempotencyKey.length > IDEMPOTENCY_KEY_MAX) {
    fail("Idempotency-Key", "VALIDATION_ERROR", `Idempotency-Key must have at most ${IDEMPOTENCY_KEY_MAX} characters`);
  } else if (CONTROL_CHARS.test(idempotencyKey)) {
    fail("Idempotency-Key", "VALIDATION_ERROR", "Idempotency-Key must not contain control characters");
  }

  if (!isRecord(body)) {
    fail("body", "VALIDATION_ERROR", "body must be a JSON object");
    return { ok: false, code: "VALIDATION_ERROR", errors };
  }

  const text = (field: string, max: number): string | undefined => {
    const v = body[field];
    if (typeof v !== "string" || v.length < 1 || v.length > max) {
      fail(field, "VALIDATION_ERROR", `${field} must be a string with 1 to ${max} characters`);
      return undefined;
    }
    if (CONTROL_CHARS.test(v)) {
      fail(field, "VALIDATION_ERROR", `${field} must not contain control characters`);
      return undefined;
    }
    return v;
  };

  const providerId = body.providerId;
  if (typeof providerId !== "string" || !PROVIDER_ID_PATTERN.test(providerId)) {
    fail("providerId", "VALIDATION_ERROR", "providerId must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$");
  }
  const externalTransactionId = text("externalTransactionId", EXTERNAL_ID_MAX);
  const playerId = text("playerId", PLAYER_ID_MAX);
  const walletId = body.walletId;
  if (typeof walletId !== "string" || !UUID_PATTERN.test(walletId)) {
    fail("walletId", "VALIDATION_ERROR", "walletId must be a UUID");
  }
  const roundId = text("roundId", EXTERNAL_ID_MAX);
  const gameId = text("gameId", EXTERNAL_ID_MAX);

  const kind = body.kind;
  if (kind === WagerTransactionKind.Opening) {
    fail("kind", "FORBIDDEN_KIND", "OPENING is internal and cannot be submitted");
  } else if (typeof kind !== "string" || !EXTERNAL_KINDS.has(kind)) {
    fail("kind", "VALIDATION_ERROR", "kind must be one of BET, WIN, LOSS, REFUND, ROLLBACK");
  }

  let money: Money | undefined;
  if (!isRecord(body.money)) {
    fail("money", "INVALID_AMOUNT", 'money must be an object like { "amount": "25.00", "currency": "BRL" }');
  } else {
    try {
      money = Money.from({ amount: body.money.amount as string, currency: body.money.currency as string });
    } catch (e) {
      if (!(e instanceof DomainValidationError)) throw e;
      fail(e.field ?? "money", e.code, e.message);
    }
  }

  let reference: string | undefined;
  const rawRef = body.referenceExternalTransactionId;
  if (rawRef !== undefined && rawRef !== null) {
    reference = text("referenceExternalTransactionId", EXTERNAL_ID_MAX);
  }
  if ((kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback) && rawRef == null) {
    fail("referenceExternalTransactionId", "MISSING_REFERENCE", `${kind} requires referenceExternalTransactionId`);
  }
  if (kind === WagerTransactionKind.Bet && reference !== undefined) {
    fail("referenceExternalTransactionId", "VALIDATION_ERROR", "BET cannot reference another transaction");
  }
  if (reference !== undefined && reference === externalTransactionId) {
    fail("referenceExternalTransactionId", "VALIDATION_ERROR", "a transaction cannot reference itself");
  }

  if (errors.length > 0) {
    return { ok: false, code: errors.length === 1 ? errors[0]!.code : "VALIDATION_ERROR", errors };
  }

  const command: SubmitWagerCommand = {
    providerId: providerId as string,
    externalTransactionId: externalTransactionId!,
    idempotencyKey: idempotencyKey as string,
    playerId: playerId!,
    walletId: (walletId as string).toLowerCase(),
    roundId: roundId!,
    gameId: gameId!,
    kind: kind as ExternalWagerKind,
    money: money!,
  };
  if (reference !== undefined) command.referenceExternalTransactionId = reference;
  return { ok: true, command };
}
