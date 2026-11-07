import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { parseWagerCommand, type SubmitWagerCommand } from "../../src/application/wager-command";
import { payloadHashOf } from "../../src/application/payload-hash";

const WALLET = "0192f291-27dd-7d3f-8071-5f8685deef37";
const body = (over: Record<string, unknown> = {}) => ({
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  walletId: WALLET,
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
  ...over,
});

function command(over: Record<string, unknown> = {}, key = "provider-a:transaction-123"): SubmitWagerCommand {
  const r = parseWagerCommand(body(over), key);
  if (!r.ok) throw new Error(`invalid test command: ${JSON.stringify(r.errors)}`);
  return r.command;
}

describe("payloadHashOf (RFC 8785 canonical JSON + SHA-256, versioned)", () => {
  it("matches an independently computed canonical form", () => {
    const canonical =
      '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET",' +
      '"money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",' +
      '"providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}';
    const expected = "v1:sha256:" + createHash("sha256").update(canonical, "utf8").digest("hex");
    expect(payloadHashOf(command())).toBe(expected);
  });

  it("does not depend on the key order of the incoming body", () => {
    const reordered = parseWagerCommand(
      {
        money: { currency: "BRL", amount: "25.00" },
        kind: "BET",
        gameId: "fortune-chimp",
        roundId: "round-987",
        walletId: WALLET,
        playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
        externalTransactionId: "transaction-123",
        providerId: "provider-a",
      },
      "provider-a:transaction-123",
    );
    if (!reordered.ok) throw new Error("unexpected");
    expect(payloadHashOf(reordered.command)).toBe(payloadHashOf(command()));
  });

  it("the Idempotency-Key and transport metadata are not part of the hash", () => {
    expect(payloadHashOf(command({}, "another-key"))).toBe(payloadHashOf(command()));
  });

  it("same idempotency key with a divergent payload gives a different hash (conflict, not replay)", () => {
    const base = payloadHashOf(command());
    expect(payloadHashOf(command({ money: { amount: "25.01", currency: "BRL" } }))).not.toBe(base);
    expect(payloadHashOf(command({ kind: "WIN" }))).not.toBe(base);
    expect(payloadHashOf(command({ roundId: "round-988" }))).not.toBe(base);
    expect(payloadHashOf(command({ walletId: "0192f291-27dd-7d3f-8071-5f8685deef38" }))).not.toBe(base);
  });

  it("an absent optional field and an explicit null hash the same", () => {
    expect(payloadHashOf(command({ referenceExternalTransactionId: null }))).toBe(payloadHashOf(command()));
  });

  it("has the versioned prefix and a 64-char hex digest", () => {
    expect(payloadHashOf(command())).toMatch(/^v1:sha256:[0-9a-f]{64}$/);
  });
});

describe("parseWagerCommand (input validation, shared by HTTP and SQS)", () => {
  const codeOf = (over: Record<string, unknown>, key: unknown = "k-1") => {
    const r = parseWagerCommand(body(over), key);
    return r.ok ? "OK" : r.code;
  };

  it("accepts the example from the challenge", () => {
    const r = parseWagerCommand(body(), "provider-a:transaction-123");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command.money.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
      expect(r.command.idempotencyKey).toBe("provider-a:transaction-123");
    }
  });

  it.each([
    ["missing key", undefined],
    ["empty key", ""],
  ])("%s → MISSING_IDEMPOTENCY_KEY", (_l, key) => {
    const r = parseWagerCommand(body(), key);
    expect(r.ok ? "OK" : r.code).toBe("MISSING_IDEMPOTENCY_KEY");
  });

  it("key longer than 255 chars → VALIDATION_ERROR", () => {
    expect(codeOf({}, "k".repeat(256))).toBe("VALIDATION_ERROR");
  });

  it.each([
    ["OPENING kind", { kind: "OPENING" }, "FORBIDDEN_KIND"],
    ["unknown kind", { kind: "JACKPOT" }, "VALIDATION_ERROR"],
    ["amount as number", { money: { amount: 25, currency: "BRL" } }, "INVALID_AMOUNT"],
    ["amount with 3 decimals", { money: { amount: "25.005", currency: "BRL" } }, "INVALID_AMOUNT"],
    ["negative amount", { money: { amount: "-1.00", currency: "BRL" } }, "INVALID_AMOUNT"],
    ["lower-case currency", { money: { amount: "1.00", currency: "brl" } }, "INVALID_CURRENCY"],
    ["REFUND without reference", { kind: "REFUND" }, "MISSING_REFERENCE"],
    ["ROLLBACK without reference", { kind: "ROLLBACK" }, "MISSING_REFERENCE"],
    ["reserved provider id", { providerId: "__internal__" }, "VALIDATION_ERROR"],
    ["provider id with spaces", { providerId: "provider a" }, "VALIDATION_ERROR"],
    ["walletId not a UUID", { walletId: "wallet-1" }, "VALIDATION_ERROR"],
    ["missing roundId", { roundId: undefined }, "VALIDATION_ERROR"],
    ["empty playerId", { playerId: "" }, "VALIDATION_ERROR"],
    ["BET with reference", { referenceExternalTransactionId: "x" }, "VALIDATION_ERROR"],
    ["self reference", { kind: "REFUND", referenceExternalTransactionId: "transaction-123" }, "VALIDATION_ERROR"],
    ["externalTransactionId too long", { externalTransactionId: "e".repeat(129) }, "VALIDATION_ERROR"],
  ])("%s → %s", (_label, over, code) => {
    expect(codeOf(over)).toBe(code as string);
  });

  it("a non-object body is a validation error", () => {
    const r = parseWagerCommand("not json", "k");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("VALIDATION_ERROR");
  });

  it("reports every invalid field, with VALIDATION_ERROR when there is more than one", () => {
    const r = parseWagerCommand(body({ walletId: "nope", money: { amount: "1", currency: "BRL" } }), "k");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("VALIDATION_ERROR");
      expect(r.errors.map((e) => e.field).sort()).toEqual(["money.amount", "walletId"]);
    }
  });
});
