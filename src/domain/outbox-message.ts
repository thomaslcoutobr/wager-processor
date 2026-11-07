import { InvalidStateError } from "./errors";
import type { IntegrationEvent } from "./events";
import { jitter } from "./pending-reference-policy";

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  messageGroupId: string;
  eventType: string;
  eventVersion: number;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt?: Date;
  lastError?: string;
}

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 300_000;

/**
 * A row of the transactional outbox. Written in the same SQL transaction as the business change,
 * published later by the OutboxPublisher (at least once; consumers dedupe by eventId).
 */
export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly messageGroupId: string,
    readonly eventType: string,
    readonly eventVersion: number,
    readonly payload: Readonly<Record<string, unknown>>,
    readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date,
    private _publishedAt: Date | undefined,
    private _lastError: string | undefined,
  ) {}

  /** `messageGroupId` keeps FIFO order per wallet in the events queue. */
  static enqueue(event: IntegrationEvent<unknown>, opts: { messageGroupId: string }): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      opts.messageGroupId,
      event.eventType,
      event.version,
      event.toJSON() as unknown as Record<string, unknown>,
      event.occurredAt,
      0,
      event.occurredAt,
      undefined,
      undefined,
    );
  }

  static rehydrate(s: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      s.id,
      s.aggregateId,
      s.messageGroupId,
      s.eventType,
      s.eventVersion,
      s.payload,
      s.occurredAt,
      s.attempts,
      s.nextAttemptAt,
      s.publishedAt,
      s.lastError,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._publishedAt ? undefined : this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }
  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    if (!this.isPending()) throw new InvalidStateError(`outbox message ${this.id} is already published`);
    this._publishedAt = at;
  }

  /** attempts + 1; next = now + min(300 s, 2^attempts s) × jitter(0.5..1). */
  scheduleRetry(now: Date, error: string, random: () => number = Math.random): void {
    if (!this.isPending()) throw new InvalidStateError(`outbox message ${this.id} is already published`);
    this._attempts += 1;
    const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** this._attempts) * jitter(random);
    this._nextAttemptAt = new Date(now.getTime() + Math.round(delay));
    this._lastError = error.slice(0, 500);
  }

  toState(): OutboxMessageState {
    return {
      id: this.id,
      aggregateId: this.aggregateId,
      messageGroupId: this.messageGroupId,
      eventType: this.eventType,
      eventVersion: this.eventVersion,
      payload: this.payload,
      occurredAt: this.occurredAt,
      attempts: this._attempts,
      nextAttemptAt: this._nextAttemptAt,
      publishedAt: this._publishedAt,
      lastError: this._lastError,
    };
  }
}
