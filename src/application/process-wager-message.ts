import { DomainValidationError } from "../domain/errors";
import { WagerTransaction } from "../domain/wager-transaction";
import { DatabaseInvariantError, RetryableConflictError, TransientError } from "./errors";
import { outboxFor } from "./event-factory";
import { payloadHashOf } from "./payload-hash";
import { InboxMessage } from "../domain/inbox-message";
import type { Clock, IdGenerator, RequestContext, UnitOfWork } from "./ports";
import type { SubmitWagerTransaction } from "./submit-wager-transaction";
import { parseWagerCommand, type SubmitWagerCommand } from "./wager-command";

export const WAGER_REQUESTED = "WagerTransactionRequested";

/** What the consumer must do with the SQS message. */
export type MessageOutcome =
  | { action: "ack"; note: "committed" | "replay" | "inbox_duplicate" }
  | { action: "dlq"; reason: string }
  | { action: "retry"; reason: string };

export interface MessageMeta {
  /** id of the logical message (envelope `messageId`), reported for logs */
  onEnvelope?(messageId: string, correlationId: string): void;
}

interface Envelope {
  messageId: string;
  type: string;
  correlationId?: string;
  data: Record<string, unknown>;
}

function parseEnvelope(body: string): Envelope | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { error: "INVALID_JSON" };
  }
  if (typeof raw !== "object" || raw === null) return { error: "INVALID_ENVELOPE" };
  const e = raw as Record<string, unknown>;
  if (typeof e.messageId !== "string" || e.messageId.length < 1 || e.messageId.length > 255) return { error: "INVALID_ENVELOPE" };
  if (e.type !== WAGER_REQUESTED) return { error: "UNKNOWN_MESSAGE_TYPE" };
  if (typeof e.data !== "object" || e.data === null) return { error: "INVALID_ENVELOPE" };
  return {
    messageId: e.messageId,
    type: e.type,
    correlationId: typeof e.correlationId === "string" ? e.correlationId : undefined,
    data: e.data as Record<string, unknown>,
  };
}

/**
 * Queue entry (ARCHITECTURE §12). Reuses the HTTP use case unchanged and only adds the three error
 * classes of the queue: business outcome → ack; permanent → DLQ with reason; transient → retry.
 */
export class ProcessWagerMessage {
  constructor(
    private readonly submit: SubmitWagerTransaction,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly consumerName: string,
  ) {}

  async handle(body: string, meta: MessageMeta = {}): Promise<MessageOutcome> {
    const envelope = parseEnvelope(body);
    if ("error" in envelope) return { action: "dlq", reason: envelope.error };

    const parsed = parseWagerCommand(envelope.data, envelope.data.idempotencyKey);
    if (!parsed.ok) return { action: "dlq", reason: parsed.code };

    const ctx: RequestContext = {
      source: "sqs",
      correlationId: envelope.correlationId ?? envelope.messageId,
      causationId: envelope.messageId,
    };
    meta.onEnvelope?.(envelope.messageId, ctx.correlationId);
    try {
      const result = await this.submit.execute(parsed.command, ctx, { consumerName: this.consumerName, messageId: envelope.messageId });
      switch (result.type) {
        case "decided":
          return { action: "ack", note: result.replay ? "replay" : "committed" };
        case "inbox_duplicate":
          return { action: "ack", note: "inbox_duplicate" };
        case "inbox_conflict":
          return { action: "dlq", reason: "MESSAGE_ID_PAYLOAD_MISMATCH" };
        case "conflict":
          return { action: "dlq", reason: result.code };
        case "wallet_not_found":
          return { action: "dlq", reason: "WALLET_NOT_FOUND" };
      }
    } catch (err) {
      if (err instanceof DomainValidationError) return { action: "dlq", reason: err.code };
      if (err instanceof DatabaseInvariantError) {
        // the schema refused a decision the domain accepted: deterministic, retrying cannot help.
        // Record it as FAILED (auditable, visible in GET) and dead-letter the message.
        await this.recordFailure(parsed.command, ctx, envelope.messageId);
        return { action: "dlq", reason: "PROCESSING_FAILED" };
      }
      if (err instanceof TransientError) return { action: "retry", reason: err.code };
      if (err instanceof RetryableConflictError) return { action: "retry", reason: "CONCURRENCY_RETRY_EXHAUSTED" };
      return { action: "retry", reason: `UNEXPECTED: ${String(err).slice(0, 120)}` };
    }
  }

  /** FAILED PROCESSING_FAILED in its own transaction, locking the wallet first like any write. */
  private async recordFailure(command: SubmitWagerCommand, ctx: RequestContext, messageId: string): Promise<void> {
    const hash = payloadHashOf(command);
    await this.uow.run(async (store) => {
      const now = this.clock.now();
      const wallet = await store.lockWallet(command.walletId);
      if (!wallet) return;
      const existing = await store.findTransactionsByKeyOrExternalId(command.providerId, command.idempotencyKey, command.externalTransactionId);
      if (existing.length > 0) return; // someone else recorded an outcome meanwhile
      const tx = WagerTransaction.create({
        id: this.ids.next(),
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash: hash,
        walletId: command.walletId,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        money: command.money,
        referenceExternalTransactionId: command.referenceExternalTransactionId,
        createdAt: now,
      });
      tx.fail({ code: "PROCESSING_FAILED", at: now });
      await store.insertTransaction(tx);
      const inbox = InboxMessage.receive({ consumerName: this.consumerName, messageId, payloadHash: hash, at: now });
      inbox.markProcessed(now);
      await store.insertInbox(inbox);
      await store.insertOutbox(outboxFor({ transaction: tx, wallet, ctx, now }, this.ids));
    });
  }
}
