import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import type { SubmitWagerCommand } from "./wager-command";

export const PAYLOAD_HASH_VERSION = "v1";

/**
 * payloadHash = "v1:sha256:" + hex(sha256(utf8(JCS(subset))))   (ARCHITECTURE §8.2)
 *
 * - JCS is RFC 8785 (lib `canonicalize`): sorted keys, fixed serialization.
 * - Computed over the VALIDATED command, never the raw body (amount already has 2 decimals).
 * - Absent optional fields are omitted, so `{a}` and `{a, b: null}` hash the same.
 * - Not hashed: Idempotency-Key, messageId, occurredAt, any transport metadata. HTTP and SQS
 *   therefore produce the same hash for the same business operation.
 * - All values are strings: the fragile part of JCS (IEEE-754 number output) is never exercised.
 */
export function payloadHashOf(c: SubmitWagerCommand): string {
  const subset: Record<string, unknown> = {
    providerId: c.providerId,
    externalTransactionId: c.externalTransactionId,
    playerId: c.playerId,
    walletId: c.walletId,
    roundId: c.roundId,
    gameId: c.gameId,
    kind: c.kind,
    money: c.money.toJSON(),
  };
  if (c.referenceExternalTransactionId !== undefined) {
    subset.referenceExternalTransactionId = c.referenceExternalTransactionId;
  }
  const canonical = canonicalize(subset);
  if (canonical === undefined) throw new Error("payload subset is not serializable");
  return `${PAYLOAD_HASH_VERSION}:sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}
