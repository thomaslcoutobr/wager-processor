/**
 * Stable, machine-readable failure codes (ARCHITECTURE §11). Grouped by what the provider should do:
 * A/B mean "your request is wrong", C is a final business rejection, D is a permanent processing
 * failure, E is transient (retry the same request).
 */
export const ValidationCodes = [
  "VALIDATION_ERROR",
  "MISSING_IDEMPOTENCY_KEY",
  "INVALID_AMOUNT",
  "INVALID_CURRENCY",
  "FORBIDDEN_KIND",
  "MISSING_REFERENCE",
] as const;

export const ConflictCodes = [
  "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH",
  "EXTERNAL_TRANSACTION_ID_CONFLICT",
  "WALLET_ALREADY_EXISTS",
  "WALLET_NOT_FOUND",
  "TRANSACTION_NOT_FOUND",
  "MESSAGE_ID_PAYLOAD_MISMATCH",
] as const;

export const BusinessRejectionCodes = [
  "INSUFFICIENT_FUNDS",
  "REVERSAL_INSUFFICIENT_FUNDS",
  "CURRENCY_MISMATCH",
  "PLAYER_WALLET_MISMATCH",
  "REFERENCE_NOT_FOUND",
  "REFERENCE_MISMATCH",
  "REFERENCE_KIND_NOT_ALLOWED",
  "REFERENCE_NOT_PROCESSED",
  "ALREADY_REVERSED",
  "AMOUNT_MISMATCH",
  "BALANCE_LIMIT_EXCEEDED",
] as const;

export const PermanentFailureCodes = ["PROCESSING_FAILED"] as const;

export const TransientCodes = [
  "SERVICE_UNAVAILABLE",
  "DATABASE_UNAVAILABLE",
  "LOCK_TIMEOUT",
  "CONCURRENCY_RETRY_EXHAUSTED",
] as const;

export type ValidationCode = (typeof ValidationCodes)[number];
export type ConflictCode = (typeof ConflictCodes)[number];
export type BusinessRejectionCode = (typeof BusinessRejectionCodes)[number];
export type PermanentFailureCode = (typeof PermanentFailureCodes)[number];
export type TransientCode = (typeof TransientCodes)[number];

export type FailureCode = ValidationCode | ConflictCode | BusinessRejectionCode | PermanentFailureCode | TransientCode;

const business: ReadonlySet<string> = new Set(BusinessRejectionCodes);
const permanent: ReadonlySet<string> = new Set(PermanentFailureCodes);

export function isBusinessRejectionCode(code: string): code is BusinessRejectionCode {
  return business.has(code);
}

export function isPermanentFailureCode(code: string): code is PermanentFailureCode {
  return permanent.has(code);
}
